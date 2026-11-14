/*
 * Effects.cpp
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

#include "Effects.hpp"

#include <QJsonArray>
#include <QJsonValue>
#include <algorithm>
#include <cmath>

namespace Compositor
{

namespace
{
	const double Pi = 3.14159265358979323846;
	const int MaxLedIndex = 4095;

	Rgba rgba(const QColor &c, float a = 1.0f, float level = 1.0f)
	{
		return { float(c.red()) * level, float(c.green()) * level, float(c.blue()) * level, a };
	}

	// smooth 0..1 bump over one period (0 at the start/end, 1 in the middle)
	float bump(double phase)
	{
		return float(0.5 - 0.5 * std::cos(2.0 * Pi * phase));
	}

	QColor gradientAt(const QList<GradientStop> &stops, float pos)
	{
		if (stops.isEmpty())
			return Qt::black;
		if (pos <= stops.first().at)
			return stops.first().color;
		for (int i = 1; i < stops.size(); ++i) {
			if (pos <= stops[i].at) {
				const GradientStop &a = stops[i - 1];
				const GradientStop &b = stops[i];
				const float span = qMax(1e-6f, b.at - a.at);
				const float k = (pos - a.at) / span;
				return QColor(
					qRound(a.color.red() + (b.color.red() - a.color.red()) * k),
					qRound(a.color.green() + (b.color.green() - a.color.green()) * k),
					qRound(a.color.blue() + (b.color.blue() - a.color.blue()) * k));
			}
		}
		return stops.last().color;
	}

	bool readColor(const QJsonObject &json, const char *key, QColor *out, QString *error)
	{
		if (!json.contains(QLatin1String(key)))
			return true;
		const QColor c(json.value(QLatin1String(key)).toString());
		if (!c.isValid()) {
			*error = QStringLiteral("invalid color in '%1' (use #rrggbb)").arg(QLatin1String(key));
			return false;
		}
		*out = c;
		return true;
	}
}

bool Pattern::animated() const
{
	switch (kind) {
	case Kind::Breathe: case Kind::Rainbow: case Kind::Pulse: case Kind::Flash: case Kind::Wave:
		return true;
	default:
		return false;
	}
}

bool parsePattern(const QJsonObject &json, Pattern *out, QString *error, bool overlay)
{
	Pattern p;
	const QString type = json.value(QLatin1String("type")).toString().toLower();

	if (type == QLatin1String("source") || type == QLatin1String("screen")) p.kind = Kind::Source;
	else if (type == QLatin1String("off")) p.kind = Kind::Off;
	else if (type == QLatin1String("solid")) p.kind = Kind::Solid;
	else if (type == QLatin1String("gradient")) p.kind = Kind::Gradient;
	else if (type == QLatin1String("breathe")) p.kind = Kind::Breathe;
	else if (type == QLatin1String("rainbow")) p.kind = Kind::Rainbow;
	else if (type == QLatin1String("pulse")) p.kind = Kind::Pulse;
	else if (type == QLatin1String("flash")) p.kind = Kind::Flash;
	else if (type == QLatin1String("wave")) p.kind = Kind::Wave;
	else {
		*error = QStringLiteral("unknown type '%1'").arg(type);
		return false;
	}
	if (overlay && (p.kind == Kind::Source || p.kind == Kind::Off)) {
		*error = QStringLiteral("type '%1' is not an overlay effect").arg(type);
		return false;
	}
	if (!overlay && (p.kind == Kind::Pulse || p.kind == Kind::Flash || p.kind == Kind::Wave)) {
		*error = QStringLiteral("type '%1' is only available as an overlay effect").arg(type);
		return false;
	}

	if (!readColor(json, "color", &p.color, error))
		return false;

	if (json.contains(QLatin1String("stops"))) {
		for (const QJsonValue &v : json.value(QLatin1String("stops")).toArray()) {
			const QJsonObject s = v.toObject();
			const QColor c(s.value(QLatin1String("color")).toString());
			if (!c.isValid()) {
				*error = QStringLiteral("invalid color in gradient stop");
				return false;
			}
			p.stops.append({ float(qBound(0.0, s.value(QLatin1String("at")).toDouble(), 1.0)), c });
		}
		std::sort(p.stops.begin(), p.stops.end(), [](const GradientStop &a, const GradientStop &b) { return a.at < b.at; });
	}
	if (p.kind == Kind::Gradient && p.stops.size() < 2) {
		*error = QStringLiteral("gradient needs at least 2 stops");
		return false;
	}

	p.brightness = float(qBound(0.0, json.value(QLatin1String("brightness")).toDouble(1.0), 1.0));
	p.periodMs = qBound(50, json.value(QLatin1String("period_ms")).toInt(p.kind == Kind::Rainbow ? 8000 : 1000), 600000);
	p.count = qMax(0, json.value(QLatin1String("count")).toInt(p.kind == Kind::Pulse ? 3 : 0));
	p.width = float(qBound(0.02, json.value(QLatin1String("width")).toDouble(0.25), 1.0));
	p.minLevel = float(qBound(0.0, json.value(QLatin1String("min")).toDouble(0.0), 1.0));
	const QString dir = json.value(QLatin1String("direction")).toString();
	p.reverse = dir == QLatin1String("left") || dir == QLatin1String("reverse");

	*out = p;
	return true;
}

int naturalDurationMs(const Pattern &p)
{
	if ((p.kind == Kind::Pulse || p.kind == Kind::Flash) && p.count > 0)
		return p.periodMs * p.count;
	return 0;
}

Rgba evaluate(const Pattern &p, double tMs, float pos)
{
	const double phase = std::fmod(tMs / p.periodMs, 1.0);
	switch (p.kind) {
	case Kind::Off:
		return { 0, 0, 0, 1 };
	case Kind::Solid:
		return rgba(p.color, 1.0f, p.brightness);
	case Kind::Gradient:
		return rgba(gradientAt(p.stops, pos), 1.0f, p.brightness);
	case Kind::Breathe: {
		const float level = p.minLevel + (1.0f - p.minLevel) * bump(phase);
		return rgba(p.color, 1.0f, level * p.brightness);
	}
	case Kind::Rainbow: {
		double hue = std::fmod(phase + pos, 1.0);
		if (hue < 0) hue += 1.0;
		return rgba(QColor::fromHsvF(hue, 1.0, 1.0), 1.0f, p.brightness);
	}
	case Kind::Pulse:
		// overlay alpha follows a soft bump each period; color stays constant
		return rgba(p.color, bump(phase), p.brightness);
	case Kind::Flash:
		return rgba(p.color, phase < 0.5 ? 1.0f : 0.0f, p.brightness);
	case Kind::Wave: {
		// a soft band travelling along the target
		const double head = p.reverse ? 1.0 - phase : phase;
		double d = std::fabs(pos - head);
		d = std::min(d, 1.0 - d); // wrap around
		const float a = d >= p.width ? 0.0f : float(0.5 + 0.5 * std::cos(Pi * d / p.width));
		return rgba(p.color, a, p.brightness);
	}
	case Kind::Source:
		break;
	}
	return { 0, 0, 0, 0 };
}

bool parseLedSet(const QJsonObject &json, LedSet *out, QString *error)
{
	LedSet set;
	set.all = json.value(QLatin1String("all")).toBool(false);
	if (!set.all) {
		for (const QJsonValue &v : json.value(QLatin1String("ranges")).toArray()) {
			const QJsonArray r = v.toArray();
			if (r.size() != 2) {
				*error = QStringLiteral("each range must be [first, last]");
				return false;
			}
			const int a = r.at(0).toInt(-1), b = r.at(1).toInt(-1);
			if (a < 0 || b < a || b > MaxLedIndex) {
				*error = QStringLiteral("invalid range [%1, %2]").arg(a).arg(b);
				return false;
			}
			for (int i = a; i <= b; ++i)
				set.indices.append(i);
		}
		for (const QJsonValue &v : json.value(QLatin1String("list")).toArray()) {
			const int i = v.toInt(-1);
			if (i < 0 || i > MaxLedIndex) {
				*error = QStringLiteral("invalid LED index %1").arg(i);
				return false;
			}
			set.indices.append(i);
		}
		if (set.indices.isEmpty()) {
			*error = QStringLiteral("no LEDs selected");
			return false;
		}
	}
	*out = set;
	return true;
}

} // namespace Compositor
