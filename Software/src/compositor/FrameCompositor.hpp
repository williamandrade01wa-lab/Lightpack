/*
 * FrameCompositor.hpp
 *
 *	Project: Prismatik
 *
 *	Single point between the color sources (screen grab, mood lamp, sound
 *	visualizer, API/plugins) and the LED device. Per frame:
 *
 *	  1. BASE     each LED takes the mode of its group: "source" (what the active
 *	              profile mode produces), solid, gradient, breathe, rainbow, off
 *	  2. SMOOTH   software smoothing of the base (devices without hardware smoothing)
 *	  3. OVERLAYS temporary effects (pulse, flash, wave...) on top, by priority,
 *	              with fade in/out; the base keeps running underneath, so when an
 *	              overlay ends the LEDs return to it smoothly
 *	  4. OUTPUT   one frame to the device, never faster than the link can carry;
 *	              newer frames replace pending ones (no accumulated latency)
 *
 *	Groups come from the profile (Compositor/Groups, JSON). Overlays come from
 *	triggers (API "trigger:" command now, HTTP API later).
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

#include "Effects.hpp"

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

	// Validates a trigger/overlay JSON without applying it (usable from any thread).
	static bool validateOverlayJson(const QString &json, QString *error);

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

	// JSON array of groups (empty / invalid = every LED follows the source)
	void setGroupsJson(const QString &json);

	// Start an overlay from a trigger JSON (formats in compositor/README.md)
	void triggerOverlay(const QString &json);
	// Fade out and remove an overlay by id ("*" = all)
	void removeOverlay(const QString &id);

signals:
	void frameReady(const QList<QRgb> &colors);

private slots:
	void emitFrame();

private:
	enum class Blend { Alpha, Override, Add };

	struct Group {
		QString id;
		Compositor::LedSet leds;
		Compositor::Pattern mode;
	};

	struct Overlay {
		QString id;
		Compositor::LedSet target;
		QStringList targetGroups;
		Compositor::Pattern effect;
		Blend blend{ Blend::Alpha };
		float opacity{ 1.0f };
		int priority{ 50 };
		qint64 startMs{ 0 };
		int durationMs{ 0 };       // 0 = until removed
		int fadeInMs{ 0 };
		int fadeOutMs{ 0 };
		qint64 removeAtMs{ -1 };   // set when removed explicitly (fade out from there)
		QVector<int> resolved;     // LED indices, built for the current LED count
	};

	void scheduleEmit();
	bool smoothingActive() const;
	bool needsClock() const;
	void rebuildLayout();                       // per-LED group map for the current LED count
	QVector<int> resolve(const Compositor::LedSet &set) const;
	void resolveOverlay(Overlay &overlay) const;
	float envelope(const Overlay &overlay, qint64 nowMs) const;   // 0..1, <0 = finished

	// source + smoothing
	QVector<QRgb> m_source;      // latest source frame
	QVector<float> m_current;    // smoothed base, 3 floats per LED
	bool m_hasCurrent{ false };
	int m_ledCount{ 0 };

	int m_smoothness{ 0 };
	bool m_softwareSmoothing{ true };
	double m_minIntervalMs{ 0.0 };

	// groups
	QList<Group> m_groups;
	QVector<int> m_ledGroup;     // LED index -> group index, -1 = source
	QVector<float> m_ledPos;     // LED position 0..1 inside its group
	bool m_animatedGroups{ false };

	// overlays, kept sorted by priority (low first, so high ends up on top)
	QList<Overlay> m_overlays;

	QTimer *m_timer{ nullptr };
	QElapsedTimer m_clock;       // monotonic time base for effects
	QElapsedTimer m_sinceLastEmit;
	bool m_everEmitted{ false };
};
