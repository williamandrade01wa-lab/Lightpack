/*
 * BasicPanel.cpp
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

#include "BasicPanel.hpp"
#include "Theme.hpp"

#include <QButtonGroup>
#include <QEvent>
#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QSignalBlocker>
#include <QSlider>
#include <QToolButton>
#include <QVBoxLayout>

namespace
{
	const QChar GlyphScreen     = QChar(0xE7F4); // TVMonitor
	const QChar GlyphAmbient    = QChar(0xE790); // Color (palette)
	const QChar GlyphSound      = QChar(0xE8D6); // Audio
	const QChar GlyphBrightness = QChar(0xE706); // Brightness
	const QChar GlyphWizard     = QChar(0xE90F); // Repair
	const QChar GlyphExpert     = QChar(0xE713); // Settings

	QColor accentColor(const QPalette &palette)
	{
		QColor accent = palette.color(QPalette::Highlight);
		const bool dark = palette.color(QPalette::Window).lightness() < 128;
		if (dark && accent.lightness() < 140)
			accent = accent.lighter(140);
		else if (!dark && accent.lightness() > 170)
			accent = accent.darker(140);
		return accent;
	}

	QString rgba(QColor color, int alpha = 255)
	{
		color.setAlpha(alpha);
		return QStringLiteral("rgba(%1,%2,%3,%4)").arg(color.red()).arg(color.green()).arg(color.blue())
			.arg(QString::number(color.alphaF(), 'f', 3));
	}

	QFrame *card(QWidget *parent)
	{
		QFrame *frame = new QFrame(parent);
		frame->setObjectName(QStringLiteral("basicCard"));
		return frame;
	}
}

// ---------------------------------------------------------------------------
// ToggleSwitch

ToggleSwitch::ToggleSwitch(QWidget *parent)
	: QAbstractButton(parent)
{
	setCheckable(true);
	setCursor(Qt::PointingHandCursor);
	setFocusPolicy(Qt::StrongFocus);
}

QSize ToggleSwitch::sizeHint() const
{
	return QSize(52, 28);
}

void ToggleSwitch::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);

	const QRectF track = QRectF(rect()).adjusted(1, 1, -1, -1);
	const qreal radius = track.height() / 2;
	const QColor accent = accentColor(palette());
	const QColor text = palette().color(QPalette::WindowText);

	if (isChecked()) {
		p.setPen(Qt::NoPen);
		p.setBrush(isEnabled() ? accent : accent.darker(160));
	} else {
		QColor border = text;
		border.setAlpha(150);
		p.setPen(QPen(border, 1.5));
		p.setBrush(Qt::NoBrush);
	}
	p.drawRoundedRect(track, radius, radius);

	const qreal knob = track.height() - 8;
	const qreal x = isChecked() ? track.right() - 4 - knob : track.left() + 4;
	p.setPen(Qt::NoPen);
	p.setBrush(isChecked() ? (accent.lightness() > 150 ? QColor(Qt::black) : QColor(Qt::white)) : text);
	p.drawEllipse(QRectF(x, track.top() + 4, knob, knob));

	if (hasFocus()) {
		QColor ring = accent;
		ring.setAlpha(160);
		p.setPen(QPen(ring, 2));
		p.setBrush(Qt::NoBrush);
		p.drawRoundedRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5), radius + 1, radius + 1);
	}
}

// ---------------------------------------------------------------------------
// LedPreview

LedPreview::LedPreview(QWidget *parent)
	: QWidget(parent)
{
	setMinimumHeight(56);
	setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Fixed);
	m_lastRepaint.start();
}

QSize LedPreview::sizeHint() const
{
	return QSize(320, 56);
}

void LedPreview::setColors(const QList<QRgb> &colors)
{
	m_colors = colors;
	// colors can arrive 60+ times per second; ~30 repaints are plenty for a preview
	if (m_lastRepaint.elapsed() >= 33) {
		m_lastRepaint.restart();
		update();
	}
}

void LedPreview::setActive(bool active)
{
	m_active = active;
	update();
}

void LedPreview::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);

	const QRectF area = QRectF(rect()).adjusted(1, 1, -1, -1);
	QPainterPath clip;
	clip.addRoundedRect(area, 10, 10);
	p.setClipPath(clip);

	QColor empty = palette().color(QPalette::WindowText);
	empty.setAlpha(25);
	p.fillRect(area, empty);

	if (m_active && !m_colors.isEmpty()) {
		const int count = m_colors.count();
		const qreal step = area.width() / count;
		for (int i = 0; i < count; ++i) {
			const QRectF slice(area.left() + i * step, area.top(), step + 0.6, area.height());
			p.fillRect(slice, QColor(m_colors.at(i)));
		}
	}

	p.setClipping(false);
	QColor border = palette().color(QPalette::WindowText);
	border.setAlpha(40);
	p.setPen(QPen(border, 1));
	p.setBrush(Qt::NoBrush);
	p.drawRoundedRect(area, 10, 10);
}

// ---------------------------------------------------------------------------
// BasicPanel

BasicPanel::BasicPanel(QWidget *parent)
	: QWidget(parent)
{
	setObjectName(QStringLiteral("basicPanel"));

	QVBoxLayout *root = new QVBoxLayout(this);
	root->setContentsMargins(16, 8, 16, 16);
	root->setSpacing(12);

	// --- Hero card: lights on/off + live preview + brightness
	QFrame *hero = card(this);
	QVBoxLayout *heroLayout = new QVBoxLayout(hero);
	heroLayout->setContentsMargins(16, 14, 16, 14);
	heroLayout->setSpacing(10);

	QHBoxLayout *lightsRow = new QHBoxLayout();
	QVBoxLayout *lightsText = new QVBoxLayout();
	lightsText->setSpacing(2);
	m_title = new QLabel(hero);
	m_title->setObjectName(QStringLiteral("basicTitle"));
	m_status = new QLabel(hero);
	m_status->setObjectName(QStringLiteral("basicSubtle"));
	lightsText->addWidget(m_title);
	lightsText->addWidget(m_status);
	m_toggle = new ToggleSwitch(hero);
	lightsRow->addLayout(lightsText, 1);
	lightsRow->addWidget(m_toggle, 0, Qt::AlignVCenter);
	heroLayout->addLayout(lightsRow);

	m_preview = new LedPreview(hero);
	heroLayout->addWidget(m_preview);
	m_previewCaption = new QLabel(hero);
	m_previewCaption->setObjectName(QStringLiteral("basicSubtle"));
	heroLayout->addWidget(m_previewCaption);

	QHBoxLayout *brightnessRow = new QHBoxLayout();
	m_brightnessIcon = new QLabel(hero);
	m_brightness = new QSlider(Qt::Horizontal, hero);
	m_brightness->setRange(0, 100);
	m_brightness->setPageStep(10);
	m_brightnessValue = new QLabel(hero);
	m_brightnessValue->setMinimumWidth(40);
	m_brightnessValue->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
	brightnessRow->addWidget(m_brightnessIcon);
	brightnessRow->addWidget(m_brightness, 1);
	brightnessRow->addWidget(m_brightnessValue);
	heroLayout->addLayout(brightnessRow);

	root->addWidget(hero);

	// --- Profiles
	m_profilesLabel = new QLabel(this);
	m_profilesLabel->setObjectName(QStringLiteral("basicSection"));
	root->addWidget(m_profilesLabel);
	m_profilesLayout = new QHBoxLayout();
	m_profilesLayout->setSpacing(8);
	m_profilesLayout->addStretch(1);
	root->addLayout(m_profilesLayout);
	m_profileGroup = new QButtonGroup(this);
	m_profileGroup->setExclusive(true);

	// --- Modes
	m_modesLabel = new QLabel(this);
	m_modesLabel->setObjectName(QStringLiteral("basicSection"));
	root->addWidget(m_modesLabel);
	QHBoxLayout *modesRow = new QHBoxLayout();
	modesRow->setSpacing(8);
	m_modeGroup = new QButtonGroup(this);
	m_modeGroup->setExclusive(true);
	for (int i = 0; i < 3; ++i) {
		QToolButton *button = new QToolButton(this);
		button->setObjectName(QStringLiteral("basicModeTile"));
		button->setCheckable(true);
		button->setToolButtonStyle(Qt::ToolButtonTextUnderIcon);
		button->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Fixed);
		button->setMinimumHeight(72);
		button->setIconSize(QSize(24, 24));
		button->setCursor(Qt::PointingHandCursor);
		m_modeGroup->addButton(button, i);
		modesRow->addWidget(button);
		m_modeButtons[i] = button;
	}
	root->addLayout(modesRow);

	root->addStretch(1);

	// --- Footer: wizard + expert mode
	QHBoxLayout *footer = new QHBoxLayout();
	m_wizardButton = new QPushButton(this);
	m_wizardButton->setObjectName(QStringLiteral("basicLink"));
	m_wizardButton->setCursor(Qt::PointingHandCursor);
	m_expertButton = new QPushButton(this);
	m_expertButton->setObjectName(QStringLiteral("basicLink"));
	m_expertButton->setCursor(Qt::PointingHandCursor);
	footer->addWidget(m_wizardButton);
	footer->addStretch(1);
	footer->addWidget(m_expertButton);
	root->addLayout(footer);

	// --- Wiring (requests only; SettingsWindow applies them)
	connect(m_toggle, &QAbstractButton::clicked, this, [this] {
		// the switch reflects the real state, which arrives back through setLightsOn()
		m_toggle->setChecked(m_lightsOn);
		emit toggleLightsRequested();
	});
	connect(m_brightness, &QSlider::valueChanged, this, [this](int value) {
		m_brightnessValue->setText(QStringLiteral("%1%").arg(value));
		emit brightnessRequested(value);
	});
#if QT_VERSION >= QT_VERSION_CHECK(5, 15, 0)
	connect(m_modeGroup, &QButtonGroup::idClicked, this, &BasicPanel::modeRequested);
#else
	connect(m_modeGroup, qOverload<int>(&QButtonGroup::buttonClicked), this, &BasicPanel::modeRequested);
#endif
	connect(m_wizardButton, &QPushButton::clicked, this, &BasicPanel::wizardRequested);
	connect(m_expertButton, &QPushButton::clicked, this, &BasicPanel::expertModeRequested);

	// --- Look
	const QPalette pal = palette();
	const QColor text = pal.color(QPalette::WindowText);
	const QColor accent = accentColor(pal);
	const bool dark = pal.color(QPalette::Window).lightness() < 128;

	if (!Theme::iconFontFamily().isEmpty()) {
		const QColor iconColor = [&] { QColor c = text; c.setAlpha(220); return c; }();
		const QChar glyphs[] = { GlyphScreen, GlyphAmbient, GlyphSound };
		for (int i = 0; i < 3; ++i)
			m_modeButtons[i]->setIcon(Theme::glyphIcon(glyphs[i], iconColor, accent, 24));
		m_brightnessIcon->setPixmap(Theme::glyphIcon(GlyphBrightness, iconColor, accent, 18).pixmap(18, 18));
		m_wizardButton->setIcon(Theme::glyphIcon(GlyphWizard, accent, accent, 16));
		m_expertButton->setIcon(Theme::glyphIcon(GlyphExpert, accent, accent, 16));
	}

	setStyleSheet(QStringLiteral(
		"QFrame#basicCard { background: %1; border: 1px solid %2; border-radius: 12px; }"
		"QLabel#basicTitle { font-size: 16pt; font-weight: 600; }"
		"QLabel#basicSubtle { color: %3; }"
		"QLabel#basicSection { font-weight: 600; margin-top: 4px; }"
		"QToolButton#basicModeTile { background: %1; border: 1px solid %2; border-radius: 10px; padding: 8px; }"
		"QToolButton#basicModeTile:hover { border-color: %4; }"
		"QToolButton#basicModeTile:checked { background: %5; border: 2px solid %4; }"
		"QPushButton#basicProfileChip { background: transparent; border: 1px solid %2; border-radius: 14px; padding: 4px 14px; }"
		"QPushButton#basicProfileChip:hover { border-color: %4; }"
		"QPushButton#basicProfileChip:checked { background: %5; border-color: %4; color: %6; font-weight: 600; }"
		"QPushButton#basicLink { background: transparent; border: none; color: %6; padding: 4px 2px; }"
		"QPushButton#basicLink:hover { text-decoration: underline; }")
		.arg(rgba(text, dark ? 10 : 6),     // card background
			rgba(text, 40),                  // hairline
			rgba(text, 160),                 // secondary text
			rgba(accent),                    // accent border
			rgba(accent, dark ? 55 : 40),    // selected wash
			rgba(accent)));                  // accent text

	retranslate();
	setLightsOn(false);
	setBrightness(100);
}

void BasicPanel::retranslate()
{
	m_previewCaption->setText(tr("Live preview of the colors sent to your LEDs"));
	m_profilesLabel->setText(tr("Profile"));
	m_modesLabel->setText(tr("What should the lights follow?"));
	m_modeButtons[ScreenMode]->setText(tr("Screen"));
	m_modeButtons[ScreenMode]->setToolTip(tr("Colors follow what is on your screen (movies, games)"));
	m_modeButtons[MoodLampMode]->setText(tr("Ambient"));
	m_modeButtons[MoodLampMode]->setToolTip(tr("A calm color or slow color cycle, independent of the screen"));
	m_modeButtons[SoundMode]->setText(tr("Music"));
	m_modeButtons[SoundMode]->setToolTip(tr("Lights react to the sound playing on your computer"));
	m_brightness->setToolTip(tr("Brightness"));
	m_wizardButton->setText(tr("Set up my LED strip"));
	m_expertButton->setText(tr("All settings (Expert mode)"));
	m_toggle->setToolTip(tr("Turn the lights on or off"));
	updateLightsText();
}

void BasicPanel::changeEvent(QEvent *event)
{
	if (event->type() == QEvent::LanguageChange)
		retranslate();
	QWidget::changeEvent(event);
}

void BasicPanel::updateLightsText()
{
	if (m_deviceError)
		m_title->setText(tr("Device not found"));
	else
		m_title->setText(m_lightsOn ? tr("Lights on") : tr("Lights off"));
}

void BasicPanel::setLightsOn(bool on)
{
	m_lightsOn = on;
	m_toggle->setChecked(on);
	m_preview->setActive(on);
	updateLightsText();
}

void BasicPanel::setDeviceError(bool error)
{
	m_deviceError = error;
	updateLightsText();
}

void BasicPanel::setStatusText(const QString &text)
{
	m_status->setText(text);
}

void BasicPanel::setProfiles(const QStringList &profiles, const QString &current)
{
	// rebuild the chips only when the list itself changed
	QStringList existing;
	for (QAbstractButton *button : m_profileGroup->buttons())
		existing << button->text();

	if (existing != profiles) {
		for (QAbstractButton *button : m_profileGroup->buttons()) {
			m_profileGroup->removeButton(button);
			button->deleteLater();
		}
		int position = 0;
		for (const QString &name : profiles) {
			QPushButton *chip = new QPushButton(name, this);
			chip->setObjectName(QStringLiteral("basicProfileChip"));
			chip->setCheckable(true);
			chip->setCursor(Qt::PointingHandCursor);
			m_profileGroup->addButton(chip);
			m_profilesLayout->insertWidget(position++, chip);
			connect(chip, &QPushButton::clicked, this, [this, name] { emit profileRequested(name); });
		}
	}

	for (QAbstractButton *button : m_profileGroup->buttons())
		button->setChecked(button->text() == current);
}

void BasicPanel::setMode(int modeIndex)
{
	if (modeIndex >= 0 && modeIndex < 3)
		m_modeButtons[modeIndex]->setChecked(true);
}

void BasicPanel::setSoundModeAvailable(bool available)
{
	m_modeButtons[SoundMode]->setVisible(available);
}

void BasicPanel::setBrightness(int percent)
{
	const QSignalBlocker blocker(m_brightness);
	m_brightness->setValue(percent);
	m_brightnessValue->setText(QStringLiteral("%1%").arg(percent));
}

void BasicPanel::setColors(const QList<QRgb> &colors)
{
	m_preview->setColors(colors);
}
