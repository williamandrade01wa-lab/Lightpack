/*
 * FrameCompositor.hpp
 *
 *	Project: Prismatik
 *
 *	Single point between the color sources (screen grab, mood lamp, sound
 *	visualizer, API/plugins) and the LED device:
 *	  - one writer: every frame for the device goes through here
 *	  - rate cap: never sends more frames than the device link can carry
 *	    (e.g. ~24 FPS for 159 LEDs over Adalight at 115200 baud); newer frames
 *	    replace pending ones, so latency never accumulates
 *	  - software smoothing for devices without hardware smoothing (Adalight,
 *	    Ardulight, UDP...), driven by the existing "Smoothness" setting
 *
 *	Phase 1 of the compositor roadmap: one group (all LEDs), one active source.
 *	Groups, per-group modes and overlays build on top of this class.
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

#pragma once

#include <QElapsedTimer>
#include <QList>
#include <QObject>
#include <QRgb>
#include <QVector>

class QTimer;

class FrameCompositor : public QObject
{
	Q_OBJECT
public:
	explicit FrameCompositor(QObject *parent = nullptr);

	// Time constant of the software smoothing for a given "Smoothness" value (0..255).
	static double smoothingTimeConstantMs(int smoothness);

public slots:
	// latest full frame from the active color source
	void setSourceFrame(const QList<QRgb> &colors);

	// 0 = off. Same scale as Settings::getDeviceSmooth() (0..255).
	void setSmoothness(int smoothness);
	// false for devices that smooth in hardware (Lightpack), to avoid smoothing twice
	void setSoftwareSmoothingEnabled(bool enabled);
	// maximum frames per second sent to the device; <= 0 means unlimited
	void setMaxFps(double fps);
	// forget smoothing state (device switched off/on, LED count changed...)
	void reset();

signals:
	void frameReady(const QList<QRgb> &colors);

private slots:
	void emitFrame();

private:
	void scheduleEmit();
	bool smoothingActive() const;

	QVector<QRgb> m_target;      // latest source frame
	QVector<float> m_current;    // smoothed state, 3 floats (r,g,b) per LED
	bool m_hasCurrent{ false };

	int m_smoothness{ 0 };
	bool m_softwareSmoothing{ true };
	double m_minIntervalMs{ 0.0 };

	QTimer *m_timer{ nullptr };
	QElapsedTimer m_sinceLastEmit;
	bool m_everEmitted{ false };
};
