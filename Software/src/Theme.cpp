/*
 * Theme.cpp
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

#include "Theme.hpp"

#include <QApplication>
#include <QFont>
#include <QFontDatabase>
#include <QListWidget>
#include <QPainter>
#include <QPalette>
#include <QPixmap>
#include <QPushButton>

namespace
{
	// Glyphs shared by "Segoe Fluent Icons" (Windows 11) and "Segoe MDL2 Assets" (Windows 10)
	const QChar GlyphMode     = QChar(0xE7F4); // TVMonitor
	const QChar GlyphDevice   = QChar(0xE772); // Devices
	const QChar GlyphProfiles = QChar(0xE716); // People
	const QChar GlyphPlugins  = QChar(0xEA86); // Puzzle
	const QChar GlyphExpert   = QChar(0xE713); // Settings
	const QChar GlyphAbout    = QChar(0xE946); // Info
	const QChar GlyphHelp     = QChar(0xE9CE); // Unknown (question mark in a circle)

	QStringList installedFamilies()
	{
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
		return QFontDatabase::families();
#else
		return QFontDatabase().families();
#endif
	}

	QColor withAlpha(QColor color, int alpha)
	{
		color.setAlpha(alpha);
		return color;
	}

	QString rgba(const QColor &color)
	{
		return QStringLiteral("rgba(%1,%2,%3,%4)")
			.arg(color.red()).arg(color.green()).arg(color.blue())
			.arg(QString::number(color.alphaF(), 'f', 3));
	}

	bool isDark(const QPalette &palette)
	{
		return palette.color(QPalette::Window).lightness() < 128;
	}

	// The system accent (Highlight) can be too dark to read on a dark window or too
	// light on a light one; nudge it so icons and borders keep enough contrast.
	QColor readableAccent(const QPalette &palette)
	{
		QColor accent = palette.color(QPalette::Highlight);
		if (isDark(palette) && accent.lightness() < 140)
			accent = accent.lighter(140);
		else if (!isDark(palette) && accent.lightness() > 170)
			accent = accent.darker(140);
		return accent;
	}
}

namespace Theme
{

QString iconFontFamily()
{
	static const QString family = [] {
		const QStringList families = installedFamilies();
		for (const QString &candidate : { QStringLiteral("Segoe Fluent Icons"), QStringLiteral("Segoe MDL2 Assets") })
			if (families.contains(candidate))
				return candidate;
		return QString();
	}();
	return family;
}

QIcon glyphIcon(QChar glyph, const QColor &color, const QColor &selectedColor, int size)
{
	QIcon icon;
	const QString family = iconFontFamily();
	if (family.isEmpty())
		return icon;

	for (const qreal dpr : { 1.0, 1.25, 1.5, 2.0, 3.0 }) {
		for (const QIcon::Mode mode : { QIcon::Normal, QIcon::Selected, QIcon::Active }) {
			QPixmap pixmap(QSize(qRound(size * dpr), qRound(size * dpr)));
			pixmap.setDevicePixelRatio(dpr);
			pixmap.fill(Qt::transparent);

			QPainter painter(&pixmap);
			painter.setRenderHint(QPainter::TextAntialiasing);
			QFont font(family);
			font.setPixelSize(size);
			painter.setFont(font);
			painter.setPen(mode == QIcon::Normal ? color : selectedColor);
			painter.drawText(QRect(0, 0, size, size), Qt::AlignCenter, QString(glyph));
			painter.end();

			icon.addPixmap(pixmap, mode);
		}
	}
	return icon;
}

void applySidebar(QListWidget *sidebar)
{
	if (!sidebar)
		return;

	const QPalette palette = sidebar->palette();
	const QColor text = palette.color(QPalette::WindowText);
	const QColor accent = readableAccent(palette);

	// Glyph icons when the icon font exists; otherwise keep the bundled PNGs
	if (!iconFontFamily().isEmpty()) {
		const QChar glyphs[] = { GlyphMode, GlyphDevice, GlyphProfiles, GlyphPlugins, GlyphExpert, GlyphAbout };
		const int count = qMin(sidebar->count(), int(sizeof(glyphs) / sizeof(glyphs[0])));
		for (int i = 0; i < count; ++i)
			sidebar->item(i)->setIcon(glyphIcon(glyphs[i], withAlpha(text, 220), accent, 26));
		sidebar->setIconSize(QSize(26, 26));
	}

	// Uniform item cells instead of free-flowing icons with 20px spacing
	sidebar->setSpacing(0);
	sidebar->setGridSize(QSize(sidebar->minimumWidth() > 0 ? sidebar->minimumWidth() - 4 : 100, 68));
	sidebar->setUniformItemSizes(true);
	sidebar->setFocusPolicy(Qt::NoFocus); // no dotted focus rectangle around the current page

	sidebar->setStyleSheet(QStringLiteral(
		"QListWidget#%1 { background: %2; border: none; border-radius: 10px; padding: 6px 0px; outline: 0; }"
		"QListWidget#%1::item { color: %3; border-radius: 8px; margin: 2px 1px; padding-top: 8px; }"
		"QListWidget#%1::item:hover:!selected { background: %4; }"
		"QListWidget#%1::item:selected { background: %5; color: %3; border-left: 3px solid %6; }")
		.arg(sidebar->objectName(),
			rgba(withAlpha(text, isDark(palette) ? 10 : 8)),   // panel
			rgba(text),
			rgba(withAlpha(text, 18)),                         // hover
			rgba(withAlpha(accent, isDark(palette) ? 60 : 45)),// current page
			rgba(accent)));                                    // current page marker
}

void applyWindow(QWidget *window, QPushButton *primaryButton)
{
	if (!window)
		return;

	const QPalette palette = window->palette();
	const QColor text = palette.color(QPalette::WindowText);
	const QColor accent = readableAccent(palette);
	const QColor onAccent = accent.lightness() > 150 ? QColor(Qt::black) : QColor(Qt::white);

	QString style = QStringLiteral(
		// group boxes: one consistent rounded card style with a bold title
		"QGroupBox { border: 1px solid %1; border-radius: 8px; margin-top: 14px; padding: 12px 8px 8px 8px; }"
		"QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top left; left: 10px; padding: 0px 4px; font-weight: 600; }")
		.arg(rgba(withAlpha(text, 40)));

	if (primaryButton) {
		primaryButton->setMinimumHeight(32);
		primaryButton->setCursor(Qt::PointingHandCursor);
		style += QStringLiteral(
			"QPushButton#%1 { background: %2; color: %3; border: none; border-radius: 6px; padding: 6px 18px; font-weight: 600; }"
			"QPushButton#%1:hover { background: %4; }"
			"QPushButton#%1:pressed { background: %5; }")
			.arg(primaryButton->objectName(),
				rgba(accent), rgba(onAccent),
				rgba(accent.lighter(112)), rgba(accent.darker(115)));
	}

	// replaces (not appends), so re-applying after a light/dark switch doesn't accumulate rules
	window->setStyleSheet(style);
}

void applyHelpButtons(QWidget *window)
{
	if (!window || iconFontFamily().isEmpty())
		return;
	const QPalette palette = window->palette();
	const QColor accent = readableAccent(palette);
	const QIcon help = glyphIcon(GlyphHelp, accent, accent.lighter(120), 16);
	for (QPushButton *button : window->findChildren<QPushButton *>()) {
		if (button->objectName().endsWith(QLatin1String("Help"), Qt::CaseInsensitive) && button->text().isEmpty()) {
			button->setIcon(help);
			button->setIconSize(QSize(16, 16));
			button->setCursor(Qt::WhatsThisCursor);
		}
	}
}

} // namespace Theme
