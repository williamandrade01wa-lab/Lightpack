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

#include <QTimer>
#include <cmath>

namespace
{
	// Smoothing keeps sending frames until every channel is within this distance of the target
	const float ConvergedEpsilon = 0.5f;
	// When there is no rate cap, smoothing still needs a frame clock (~60 FPS)
	const double SmoothingFallbackIntervalMs = 16.0;
}

FrameCompositor::FrameCompositor(QObject *parent)
	: QObject(parent)
{
	m_timer = new QTimer(this);
	m_timer->setSingleShot(true);
	m_timer->setTimerType(Qt::PreciseTimer);
	connect(m_timer, &QTimer::timeout, this, &FrameCompositor::emitFrame);
}

double FrameCompositor::smoothingTimeConstantMs(int smoothness)
{
	// 0 = instant; 100 (the default profile value) = 150 ms; 255 = ~380 ms
	return smoothness <= 0 ? 0.0 : smoothness * 1.5;
}

void FrameCompositor::setSourceFrame(const QList<QRgb> &colors)
{
	if (colors.size() != m_target.size())
		m_hasCurrent = false; // LED count changed: no fade from an unrelated layout

	m_target = QVector<QRgb>(colors.begin(), colors.end());
	scheduleEmit();
}

void FrameCompositor::setSmoothness(int smoothness)
{
	m_smoothness = qMax(0, smoothness);
	DEBUG_LOW_LEVEL << Q_FUNC_INFO << m_smoothness << "tau ms" << smoothingTimeConstantMs(m_smoothness);
}

void FrameCompositor::setSoftwareSmoothingEnabled(bool enabled)
{
	m_softwareSmoothing = enabled;
	DEBUG_LOW_LEVEL << Q_FUNC_INFO << enabled;
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

void FrameCompositor::scheduleEmit()
{
	if (m_timer->isActive())
		return; // a frame is already scheduled; it will pick up the newest target

	const double elapsed = m_everEmitted ? static_cast<double>(m_sinceLastEmit.nsecsElapsed()) / 1e6 : 1e9;
	double interval = m_minIntervalMs;
	if (interval <= 0.0 && smoothingActive())
		interval = SmoothingFallbackIntervalMs;

	const double wait = interval - elapsed;
	if (wait <= 0.0)
		emitFrame();
	else
		m_timer->start(static_cast<int>(std::ceil(wait)));
}

void FrameCompositor::emitFrame()
{
	if (m_target.isEmpty())
		return;

	const double dtMs = m_everEmitted ? static_cast<double>(m_sinceLastEmit.nsecsElapsed()) / 1e6 : 0.0;
	m_sinceLastEmit.restart();
	m_everEmitted = true;

	const int count = m_target.size();
	QList<QRgb> out;
	out.reserve(count);

	if (!smoothingActive() || !m_hasCurrent) {
		// no smoothing (or first frame): pass the source frame through untouched
		m_current.resize(count * 3);
		for (int i = 0; i < count; ++i) {
			const QRgb c = m_target[i];
			m_current[i * 3] = qRed(c);
			m_current[i * 3 + 1] = qGreen(c);
			m_current[i * 3 + 2] = qBlue(c);
			out.append(c);
		}
		m_hasCurrent = true;
		emit frameReady(out);
		return;
	}

	// exponential approach, frame-rate independent: alpha = 1 - e^(-dt/tau)
	const double tau = smoothingTimeConstantMs(m_smoothness);
	const float alpha = static_cast<float>(1.0 - std::exp(-qMax(dtMs, 1.0) / tau));
	bool converged = true;
	for (int i = 0; i < count; ++i) {
		const QRgb c = m_target[i];
		const float target[3] = { float(qRed(c)), float(qGreen(c)), float(qBlue(c)) };
		int channel[3];
		for (int k = 0; k < 3; ++k) {
			float &value = m_current[i * 3 + k];
			value += (target[k] - value) * alpha;
			if (std::fabs(target[k] - value) > ConvergedEpsilon)
				converged = false;
			else
				value = target[k];
			channel[k] = qBound(0, static_cast<int>(value + 0.5f), 255);
		}
		out.append(qRgb(channel[0], channel[1], channel[2]));
	}
	emit frameReady(out);

	// keep animating towards the target even if the source stops sending (e.g. a static screen)
	if (!converged)
		scheduleEmit();
}
