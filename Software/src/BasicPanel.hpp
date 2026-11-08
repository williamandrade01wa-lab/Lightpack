/*
 * BasicPanel.hpp
 *
 *	Project: Prismatik
 *
 *	"Basic" mode of the settings window: one simple screen with what people do
 *	every day (lights on/off, profile, mode, brightness) plus a live preview of
 *	the LED colors. Everything else lives in Expert mode.
 *
 *	The panel holds no application logic: it only emits requests, and
 *	SettingsWindow forwards them to the existing (Expert) controls so both
 *	views always stay in sync.
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

#include <QAbstractButton>
#include <QElapsedTimer>
#include <QList>
#include <QRgb>
#include <QWidget>

class QButtonGroup;
class QHBoxLayout;
class QLabel;
class QSlider;
class QPushButton;
class QToolButton;

// iOS/Windows style on/off switch
class ToggleSwitch : public QAbstractButton
{
	Q_OBJECT
public:
	explicit ToggleSwitch(QWidget *parent = nullptr);
	QSize sizeHint() const override;
protected:
	void paintEvent(QPaintEvent *event) override;
};

// Live strip of the colors currently sent to the LEDs
class LedPreview : public QWidget
{
	Q_OBJECT
public:
	explicit LedPreview(QWidget *parent = nullptr);
	void setColors(const QList<QRgb> &colors);
	void setActive(bool active);
	QSize sizeHint() const override;
protected:
	void paintEvent(QPaintEvent *event) override;
private:
	QList<QRgb> m_colors;
	bool m_active{ true };
	QElapsedTimer m_lastRepaint;
};

class BasicPanel : public QWidget
{
	Q_OBJECT
public:
	// same order as SettingsWindow's mode combo box
	enum ModeIndex { ScreenMode = 0, MoodLampMode = 1, SoundMode = 2 };

	explicit BasicPanel(QWidget *parent = nullptr);

	void setLightsOn(bool on);
	void setDeviceError(bool error);
	void setStatusText(const QString &text);              // "Adalight · 59 FPS"
	void setProfiles(const QStringList &profiles, const QString &current);
	void setMode(int modeIndex);
	void setSoundModeAvailable(bool available);
	void setBrightness(int percent);
	void setColors(const QList<QRgb> &colors);

signals:
	void toggleLightsRequested();
	void profileRequested(const QString &profile);
	void modeRequested(int modeIndex);
	void brightnessRequested(int percent);
	void wizardRequested();
	void expertModeRequested();

protected:
	void changeEvent(QEvent *event) override;

private:
	void retranslate();
	void updateLightsText();

	bool m_lightsOn{ false };
	bool m_deviceError{ false };

	QLabel *m_title{ nullptr };
	QLabel *m_status{ nullptr };
	ToggleSwitch *m_toggle{ nullptr };
	LedPreview *m_preview{ nullptr };
	QLabel *m_previewCaption{ nullptr };
	QLabel *m_brightnessIcon{ nullptr };
	QSlider *m_brightness{ nullptr };
	QLabel *m_brightnessValue{ nullptr };
	QLabel *m_profilesLabel{ nullptr };
	QHBoxLayout *m_profilesLayout{ nullptr };
	QButtonGroup *m_profileGroup{ nullptr };
	QLabel *m_modesLabel{ nullptr };
	QButtonGroup *m_modeGroup{ nullptr };
	QToolButton *m_modeButtons[3]{ nullptr, nullptr, nullptr };
	QPushButton *m_wizardButton{ nullptr };
	QPushButton *m_expertButton{ nullptr };
};
