/*
 * Theme.hpp
 *
 *	Project: Prismatik
 *
 *	Modern look for the settings window: crisp vector icons (Windows Fluent
 *	icon font when available), a highlighted current page in the sidebar,
 *	consistent rounded group boxes and an accent primary button.
 *	Colors come from the active palette, so light/dark mode and the system
 *	accent color are followed automatically.
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

#include <QColor>
#include <QIcon>
#include <QString>

class QListWidget;
class QPushButton;
class QWidget;

namespace Theme
{
	// Name of an installed icon font with Fluent/MDL2 glyphs, or an empty string
	// (non-Windows or old Windows): callers then keep the bundled PNG icons.
	QString iconFontFamily();

	// Icon rendered from an icon-font glyph. The Normal state uses `color`,
	// the Selected/Active states use `selectedColor`. Rendered for several
	// device pixel ratios so it stays sharp on scaled displays.
	QIcon glyphIcon(QChar glyph, const QColor &color, const QColor &selectedColor, int size);

	// Sidebar (page list): glyph icons, compact item grid, highlighted current page.
	void applySidebar(QListWidget *sidebar);

	// Window-wide stylesheet: group boxes, primary button, help buttons.
	// `primaryButton` may be null.
	void applyWindow(QWidget *window, QPushButton *primaryButton);

	// Replace the bundled "?" help PNGs on the icon-only "...Help" buttons with a glyph.
	void applyHelpButtons(QWidget *window);
}
