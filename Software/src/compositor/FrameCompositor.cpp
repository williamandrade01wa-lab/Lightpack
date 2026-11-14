/*
 * FrameCompositor.cpp
 *
 *	Project: Prismatik
 *
 *	Prismatik is free software: you can redistribute it and/or modify
 *	it under the terms of the GNU General Public License as published by
 *	the Free Software Foundation, either version 2 of the License, or
 *	(at your option) any later version.
 *
 *	Prismatik is distributed in the hope that it will be useful,
 *	but WITHOUT ANY WARRANTY; without even the implied warranty of
 *	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.	See the
 *	GNU General Public License for more details.
 *
 *	You should have received a copy of the GNU General Public License
 *	along with this program.	If not, see <http://www.gnu.org/licenses/>.
 *
 */

#include "FrameCompositor.hpp"
#include "debug.h"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <algorithm>
#include <cmath>

using namespace Compositor;

namespace
{
	// Smoothing keeps sending frames until every channel is within this distance of the target
	const float ConvergedEpsilon = 0.5f;
	// Frame clock used when animating and there is no rate cap (~60 FPS)
	const double FallbackIntervalMs = 16.0;
	const int MaxOverlays = 32;

	bool parseOverlayObject(const QJsonObject &json, QString *error,
		QString *id, LedSet *target, QStringList *groups, Pattern *effect,
		QString *blend, float *opacity, int *priority, int *duration, int *fadeIn, int *fadeOut)
	{
		*id = json.value(QLatin1String("id")).toString();
		const QJsonObject t = json.value(QLatin1String("target")).toObject();
		if (t.contains(QLatin1String("groups"))) {
			for (const QJsonValue &g : t.value(QLatin1String("groups")).toArray())
				groups->append(g.toString());
			if (groups->isEmpty()) {
				*error = QStringLiteral("target.groups is empty");
				return false;
			}
		} else if (t.contains(QLatin1String("leds"))) {
			if (!parseLedSet(t.value(QLatin1String("leds")).toObject(), target, error))
				return false;
		} else if (!parseLedSet(t, target, error)) { // {"all": true} or ranges/list directly
			*error = QStringLiteral("target needs groups, leds or all");
			return false;
		}
		if (!parsePattern(json.value(QLatin1String("effect")).toObject(), effect, error, true))
			return false;
		*blend = json.value(QLatin1String("blend")).toString(QStringLiteral("alpha"));
		if (*blend != QLatin1String("alpha") && *blend != QLatin1String("override") && *blend != QLatin1String("add")) {
			*error = QStringLiteral("blend must be alpha, override or add");
			return false;
		}
		*opacity = float(qBound(0.0, json.value(QLatin1String("opacity")).toDouble(1.0), 1.0));
		*priority = qBound(0, json.value(QLatin1String("priority")).toInt(50), 100);
		const int natural = naturalDurationMs(*effect);
		*duration = qMax(0, json.value(QLatin1String("duration_ms")).toInt(natural));
		*fadeIn = qMax(0, json.value(QLatin1String("fade_in_ms")).toInt(120));
		*fadeOut = qMax(0, json.value(QLatin1String("fade_out_ms")).toInt(300));
		return true;
	}
}

FrameCompositor::FrameCompositor(QObject *parent)
	: QObject(parent)
{
	m_timer = new QTimer(this);
	m_timer->setSingleShot(true);
	m_timer->setTimerType(Qt::PreciseTimer);
	connect(m_timer, &QTimer::timeout, this, &FrameCompositor::emitFrame);
	m_clock.start();
}

double FrameCompositor::smoothingTimeConstantMs(int smoothness)
{
	// 0 = instant; 100 (the default profile value) = 150 ms; 255 = ~380 ms
	return smoothness <= 0 ? 0.0 : smoothness * 1.5;
}

bool FrameCompositor::validateOverlayJson(const QString &json, QString *error, int *durationMs)
{
	QJsonParseError parseError;
	const QJsonDocument doc = QJsonDocument::fromJson(json.toUtf8(), &parseError);
	if (!doc.isObject()) {
		*error = QStringLiteral("invalid JSON: %1").arg(parseError.errorString());
		return false;
	}
	QString id, blend; LedSet target; QStringList groups; Pattern effect;
	float opacity; int priority, duration, fadeIn, fadeOut;
	if (!parseOverlayObject(doc.object(), error, &id, &target, &groups, &effect, &blend, &opacity, &priority, &duration, &fadeIn, &fadeOut))
		return false;
	const QString conflict = doc.object().value(QLatin1String("on_conflict")).toString(QStringLiteral("restart"));
	if (conflict != QLatin1String("restart") && conflict != QLatin1String("ignore") && conflict != QLatin1String("stack")) {
		*error = QStringLiteral("on_conflict must be restart, ignore or stack");
		return false;
	}
	if (durationMs)
		*durationMs = duration;
	return true;
}

void FrameCompositor::publishOverlays()
{
	const qint64 now = m_clock.elapsed();
	const qint64 epochNow = QDateTime::currentMSecsSinceEpoch();
	QJsonArray arr;
	for (const Overlay &o : m_overlays) {
		QJsonObject j;
		j.insert(QStringLiteral("id"), o.id);
		j.insert(QStringLiteral("priority"), o.priority);
		j.insert(QStringLiteral("effect"), o.effectName);
		j.insert(QStringLiteral("started_at_ms"), double(o.startedEpochMs ? o.startedEpochMs : epochNow - (now - o.startMs)));
		j.insert(QStringLiteral("duration_ms"), o.durationMs);
		j.insert(QStringLiteral("removing"), o.removing || o.removeAtMs >= 0);
		arr.append(j);
	}
	emit overlaysChanged(QString::fromUtf8(QJsonDocument(arr).toJson(QJsonDocument::Compact)));
}

// ---------------------------------------------------------------------------
// settings

void FrameCompositor::setSmoothness(int smoothness)
{
	m_smoothness = qMax(0, smoothness);
	DEBUG_LOW_LEVEL << Q_FUNC_INFO << m_smoothness << "tau ms" << smoothingTimeConstantMs(m_smoothness);
}

void FrameCompositor::setSoftwareSmoothingEnabled(bool enabled)
{
	m_softwareSmoothing = enabled;
}

void FrameCompositor::setMaxFps(double fps)
{
	m_minIntervalMs = fps > 0.0 ? 1000.0 / fps : 0.0;
	DEBUG_LOW_LEVEL << Q_FUNC_INFO << fps << "min interval ms" << m_minIntervalMs;
}

void FrameCompositor::reset()
{
	m_hasCurrent = false;
	m_timer->stop();
}

bool FrameCompositor::smoothingActive() const
{
	return m_softwareSmoothing && m_smoothness > 0;
}

bool FrameCompositor::needsClock() const
{
	return m_animatedGroups || !m_overlays.isEmpty();
}

// ---------------------------------------------------------------------------
// groups

void FrameCompositor::setGroupsJson(const QString &json)
{
	m_groups.clear();
	const QString trimmed = json.trimmed();
	if (!trimmed.isEmpty()) {
		QJsonParseError parseError;
		const QJsonDocument doc = QJsonDocument::fromJson(trimmed.toUtf8(), &parseError);
		if (!doc.isArray()) {
			qWarning() << Q_FUNC_INFO << "Compositor/Groups is not a JSON array:" << parseError.errorString();
		} else {
			for (const QJsonValue &v : doc.array()) {
				const QJsonObject o = v.toObject();
				Group g;
				QString error;
				g.id = o.value(QLatin1String("id")).toString();
				if (!parseLedSet(o.value(QLatin1String("leds")).toObject(), &g.leds, &error)
					|| !parsePattern(o.value(QLatin1String("mode")).toObject(), &g.mode, &error, false)) {
					qWarning() << Q_FUNC_INFO << "skipping group" << g.id << ":" << error;
					continue;
				}
				m_groups.append(g);
			}
		}
	}
	DEBUG_LOW_LEVEL << Q_FUNC_INFO << m_groups.size() << "groups";
	rebuildLayout();
	scheduleEmit();
}

QVector<int> FrameCompositor::resolve(const LedSet &set) const
{
	QVector<int> out;
	if (set.all) {
		out.reserve(m_ledCount);
		for (int i = 0; i < m_ledCount; ++i)
			out.append(i);
		return out;
	}
	out.reserve(set.indices.size());
	for (int i : set.indices)
		if (i < m_ledCount)
			out.append(i);
	return out;
}

void FrameCompositor::rebuildLayout()
{
	m_ledGroup.fill(-1, m_ledCount);
	m_ledPos.fill(0.0f, m_ledCount);
	m_animatedGroups = false;
	for (int g = 0; g < m_groups.size(); ++g) {
		const QVector<int> leds = resolve(m_groups[g].leds);
		const int n = leds.size();
		for (int k = 0; k < n; ++k) {
			if (m_ledGroup[leds[k]] != -1)
				qWarning() << Q_FUNC_INFO << "LED" << leds[k] << "is in more than one group; using" << m_groups[g].id;
			m_ledGroup[leds[k]] = g;
			m_ledPos[leds[k]] = n > 1 ? float(k) / float(n - 1) : 0.0f;
		}
		if (n > 0 && m_groups[g].mode.animated())
			m_animatedGroups = true;
	}
	for (Overlay &o : m_overlays)
		resolveOverlay(o);
}

// ---------------------------------------------------------------------------
// overlays

void FrameCompositor::resolveOverlay(Overlay &overlay) const
{
	if (overlay.targetGroups.isEmpty()) {
		overlay.resolved = resolve(overlay.target);
		return;
	}
	overlay.resolved.clear();
	for (const QString &id : overlay.targetGroups)
		for (const Group &g : m_groups)
			if (g.id == id)
				overlay.resolved += resolve(g.leds);
}

void FrameCompositor::triggerOverlay(const QString &json)
{
	const QJsonDocument doc = QJsonDocument::fromJson(json.toUtf8());
	Overlay o;
	QString error, blend;
	if (!doc.isObject() || !parseOverlayObject(doc.object(), &error, &o.id, &o.target, &o.targetGroups, &o.effect,
			&blend, &o.opacity, &o.priority, &o.durationMs, &o.fadeInMs, &o.fadeOutMs)) {
		qWarning() << Q_FUNC_INFO << "rejected trigger:" << error;
		return;
	}
	o.blend = blend == QLatin1String("override") ? Blend::Override : blend == QLatin1String("add") ? Blend::Add : Blend::Alpha;
	o.startMs = m_clock.elapsed();
	o.startedEpochMs = QDateTime::currentMSecsSinceEpoch();
	o.effectName = doc.object().value(QLatin1String("effect")).toObject().value(QLatin1String("type")).toString().toLower();
	resolveOverlay(o);

	// same id = restart (e.g. a second WhatsApp message restarts the pulse instead of stacking);
	// on_conflict "ignore" keeps the running one, "stack" keeps both
	const QString conflict = doc.object().value(QLatin1String("on_conflict")).toString(QStringLiteral("restart"));
	if (!o.id.isEmpty() && conflict != QLatin1String("stack")) {
		if (conflict == QLatin1String("ignore"))
			for (const Overlay &x : m_overlays)
				if (x.id == o.id && x.removeAtMs < 0)
					return;
		for (int i = m_overlays.size() - 1; i >= 0; --i)
			if (m_overlays[i].id == o.id)
				m_overlays.removeAt(i);
	}
	if (m_overlays.size() >= MaxOverlays)
		m_overlays.removeFirst();

	const auto pos = std::upper_bound(m_overlays.begin(), m_overlays.end(), o.priority,
		[](int p, const Overlay &x) { return p < x.priority; });
	m_overlays.insert(pos, o);
	DEBUG_LOW_LEVEL << Q_FUNC_INFO << "overlay" << o.id << "leds" << o.resolved.size() << "duration" << o.durationMs;
	publishOverlays();
	scheduleEmit();
}

void FrameCompositor::removeOverlay(const QString &id)
{
	const qint64 now = m_clock.elapsed();
	for (Overlay &o : m_overlays)
		if ((id == QLatin1String("*") || o.id == id) && o.removeAtMs < 0)
			o.removeAtMs = now;
	publishOverlays();
	scheduleEmit();
}

float FrameCompositor::envelope(const Overlay &o, qint64 now) const
{
	const qint64 t = now - o.startMs;
	float level = o.fadeInMs > 0 ? qMin(1.0f, float(t) / o.fadeInMs) : 1.0f;

	qint64 endAt = -1;
	if (o.durationMs > 0)
		endAt = o.startMs + o.durationMs;
	if (o.removeAtMs >= 0 && (endAt < 0 || o.removeAtMs < endAt))
		endAt = o.removeAtMs;
	if (endAt >= 0 && now >= endAt) {
		if (o.fadeOutMs <= 0)
			return -1.0f;
		const float out = 1.0f - float(now - endAt) / o.fadeOutMs;
		if (out <= 0.0f)
			return -1.0f;
		level = qMin(level, out);
	}
	return level;
}

// ---------------------------------------------------------------------------
// frames

void FrameCompositor::setSourceFrame(const QList<QRgb> &colors)
{
	if (colors.size() != m_ledCount) {
		m_ledCount = colors.size();
		m_hasCurrent = false; // LED count changed: no fade from an unrelated layout
		rebuildLayout();
	}
	m_source = QVector<QRgb>(colors.begin(), colors.end());
	scheduleEmit();
}

void FrameCompositor::scheduleEmit()
{
	if (m_timer->isActive() || m_ledCount == 0)
		return; // a frame is already scheduled; it will pick up the newest state

	const double elapsed = m_everEmitted ? double(m_sinceLastEmit.nsecsElapsed()) / 1e6 : 1e9;
	double interval = m_minIntervalMs;
	if (interval <= 0.0 && (smoothingActive() || needsClock()))
		interval = FallbackIntervalMs;

	const double wait = interval - elapsed;
	if (wait <= 0.0)
		emitFrame();
	else
		m_timer->start(int(std::ceil(wait)));
}

void FrameCompositor::emitFrame()
{
	if (m_ledCount == 0 || m_source.size() != m_ledCount)
		return;

	const qint64 now = m_clock.elapsed();
	const double dtMs = m_everEmitted ? double(m_sinceLastEmit.nsecsElapsed()) / 1e6 : 0.0;
	m_sinceLastEmit.restart();
	m_everEmitted = true;

	// 1. BASE + 2. SMOOTH
	const bool smooth = smoothingActive() && m_hasCurrent;
	const float alpha = smooth
		? float(1.0 - std::exp(-qMax(dtMs, 1.0) / smoothingTimeConstantMs(m_smoothness)))
		: 1.0f;
	m_current.resize(m_ledCount * 3);
	bool converged = true;
	for (int i = 0; i < m_ledCount; ++i) {
		float target[3];
		const int g = m_ledGroup[i];
		if (g < 0 || m_groups[g].mode.kind == Kind::Source) {
			const QRgb c = m_source[i];
			target[0] = qRed(c); target[1] = qGreen(c); target[2] = qBlue(c);
		} else {
			const Rgba c = evaluate(m_groups[g].mode, double(now), m_ledPos[i]);
			target[0] = c.r; target[1] = c.g; target[2] = c.b;
		}
		for (int k = 0; k < 3; ++k) {
			float &value = m_current[i * 3 + k];
			if (!smooth) {
				value = target[k];
				continue;
			}
			value += (target[k] - value) * alpha;
			if (std::fabs(target[k] - value) > ConvergedEpsilon)
				converged = false;
			else
				value = target[k];
		}
	}
	m_hasCurrent = true;

	// 3. OVERLAYS (not smoothed, so pulses stay crisp)
	QVector<float> frame = m_current;
	bool overlaysDirty = false;
	for (int idx = 0; idx < m_overlays.size(); ++idx) {
		Overlay &o = m_overlays[idx];
		const float env = envelope(o, now);
		if (env < 0.0f) {
			m_overlays.removeAt(idx--);
			overlaysDirty = true;
			continue;
		}
		const int n = o.resolved.size();
		const double t = double(now - o.startMs);
		for (int k = 0; k < n; ++k) {
			const int led = o.resolved[k];
			const Rgba c = evaluate(o.effect, t, n > 1 ? float(k) / float(n - 1) : 0.0f);
			const float a = qBound(0.0f, c.a * env * o.opacity, 1.0f);
			float *px = &frame[led * 3];
			const float src[3] = { c.r, c.g, c.b };
			for (int ch = 0; ch < 3; ++ch) {
				switch (o.blend) {
				case Blend::Alpha:    px[ch] += (src[ch] - px[ch]) * a; break;
				case Blend::Override: px[ch] = env > 0.0f ? px[ch] + (src[ch] - px[ch]) * qMin(1.0f, env * o.opacity) : px[ch]; break;
				case Blend::Add:      px[ch] += src[ch] * a; break;
				}
			}
		}
	}

	// 4. OUTPUT
	QList<QRgb> out;
	out.reserve(m_ledCount);
	for (int i = 0; i < m_ledCount; ++i)
		out.append(qRgb(qBound(0, int(frame[i * 3] + 0.5f), 255),
						qBound(0, int(frame[i * 3 + 1] + 0.5f), 255),
						qBound(0, int(frame[i * 3 + 2] + 0.5f), 255)));
	emit frameReady(out);
	if (overlaysDirty)
		publishOverlays();

	// keep the clock running while something moves on its own
	if (!converged || needsClock())
		scheduleEmit();
}
