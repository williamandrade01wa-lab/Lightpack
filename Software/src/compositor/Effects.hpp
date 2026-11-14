/*
 * Effects.hpp
 *
 *	Project: Prismatik
 *
 *	Procedural colors used by the frame compositor: per-group base modes
 *	(solid, gradient, breathe, rainbow) and overlay effects (pulse, flash,
 *	wave...). Everything is a pure function of time and LED position, so it
 *	costs next to nothing per frame.
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

#include <QBitArray>
#include <QColor>
#include <QJsonObject>
#include <QList>
#include <QString>
#include <QVector>

namespace Compositor
{
	// RGB as floats 0..255, alpha 0..1
	struct Rgba { float r{ 0 }, g{ 0 }, b{ 0 }, a{ 0 }; };

	struct GradientStop { float at; QColor color; };

	enum class Kind {
		Source,   // whatever the active profile mode produces (screen grab, mood lamp, sound)
		Off,
		Solid,
		Gradient,
		Breathe,
		Rainbow,
		// overlay-only effects
		Pulse,
		Flash,
		Wave,
	};

	// A mode (for a group) or an effect (for an overlay), parsed from JSON
	struct Pattern {
		Kind kind{ Kind::Source };
		QColor color{ Qt::white };
		QList<GradientStop> stops;
		float brightness{ 1.0f };   // 0..1 multiplier
		int periodMs{ 1000 };       // breathe / pulse / flash / wave cycle, rainbow cycle
		int count{ 0 };             // pulse/flash repetitions (0 = endless)
		float width{ 0.25f };       // wave width, fraction of the target
		float minLevel{ 0.0f };     // breathe minimum level 0..1
		bool reverse{ false };      // wave direction
		bool animated() const;      // needs a frame clock even without new source frames
	};

	// Parses {"type": "...", ...}. Returns false and fills `error` on bad input.
	bool parsePattern(const QJsonObject &json, Pattern *out, QString *error, bool overlay);

	// Natural length of an overlay effect (e.g. pulse: period * count), 0 = endless
	int naturalDurationMs(const Pattern &pattern);

	// Color of one LED. `pos` is 0..1 along the group/target (in LED order), t in ms.
	Rgba evaluate(const Pattern &pattern, double tMs, float pos);

	// LED selection; resolved against the real LED count when frames arrive
	struct LedSet {
		bool all{ false };
		QVector<int> indices;          // 0-based, in the order given (ranges expand ascending)
	};

	// {"ranges": [[a,b],...], "list": [i,...]} or {"all": true}; indices are 0-based, inclusive ranges
	bool parseLedSet(const QJsonObject &json, LedSet *out, QString *error);
}
