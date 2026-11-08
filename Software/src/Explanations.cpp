/*
 * Explanations.cpp
 *
 *	Project: Prismatik
 *
 *	Plain-language explanation for every setting, shown as tooltip and as
 *	"What's this?" help. Translations live in res/translations/*.ts under the
 *	"Explanations" context.
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

#include "Explanations.hpp"

#include <QCoreApplication>
#include <QWidget>

namespace
{
	struct Explanation
	{
		const char *widgets[3]; // up to 3 controls share one explanation (unused = nullptr)
		const char *text;
	};

	const Explanation kExplanations[] = {
	{ { "comboBox_LightpackModes" }, QT_TRANSLATE_NOOP("Explanations", "Choose what the lights follow. Screen grabbing copies the colors at the edges of your screen; Mood lamp shows a calm color or a slow color cycle; Sound visualization makes the lights react to music.") },
	{ { "spinBox_GrabSlowdown" }, QT_TRANSLATE_NOOP("Explanations", "Time between two screen captures, in milliseconds. Lower = smoother, faster reaction, but more CPU. 17 ms is about 60 captures per second; 33 ms (30 per second) is enough for most movies.") },
	{ { "checkBox_GrabIsAvgColors" }, QT_TRANSLATE_NOOP("Explanations", "Paints every LED with the average color of the whole screen instead of each LED following its own area. Calmer and less detailed.") },
	{ { "checkBox_GrabApplyBlueLightReduction" }, QT_TRANSLATE_NOOP("Explanations", "If you use a blue-light filter (Windows Night light, f.lux, redshift), apply it to the LEDs too so they match your screen.") },
	{ { "checkBox_GrabApplyColorTemperature", "horizontalSlider_GrabColorTemperature", "spinBox_GrabColorTemperature" }, QT_TRANSLATE_NOOP("Explanations", "Makes the LED colors warmer (lower K, more orange) or colder (higher K, more blue). 6500K is neutral.") },
	{ { "horizontalSlider_GrabGamma", "doubleSpinBox_GrabGamma" }, QT_TRANSLATE_NOOP("Explanations", "Adjusts how mid-tones are mapped. Higher makes dark scenes darker and colors richer; lower brightens dim colors.") },
	{ { "horizontalSlider_GrabOverBrighten", "spinBox_GrabOverBrighten" }, QT_TRANSLATE_NOOP("Explanations", "Boosts dim colors so the LEDs look brighter. 0 = colors exactly as on the screen.") },
	{ { "groupBox_2" }, QT_TRANSLATE_NOOP("Explanations", "Shows on your screen the rectangles (zones) each LED reads its color from, so you can drag and resize them.") },
	{ { "radioButton_GrabWidgetsDontShow" }, QT_TRANSLATE_NOOP("Explanations", "The capture zones are not shown on the screen (normal use).") },
	{ { "radioButton_Colored" }, QT_TRANSLATE_NOOP("Explanations", "Shows each capture zone in its own color so you can move and resize it.") },
	{ { "radioButton_White" }, QT_TRANSLATE_NOOP("Explanations", "Shows the capture zones in white, handy to check that they line up with the LEDs behind the screen.") },
	{ { "groupBox_3" }, QT_TRANSLATE_NOOP("Explanations", "What the LEDs do in very dark scenes.") },
	{ { "spinBox_LuminosityThreshold", "horizontalSlider_LuminosityThreshold" }, QT_TRANSLATE_NOOP("Explanations", "Brightness level (0 to 100) below which a color counts as dark.") },
	{ { "radioButton_LuminosityDeadZone" }, QT_TRANSLATE_NOOP("Explanations", "Colors darker than the threshold switch the LED off. Gives deep blacks in dark scenes.") },
	{ { "radioButton_MinimumLuminosity" }, QT_TRANSLATE_NOOP("Explanations", "Colors darker than the threshold are raised to it, so the LEDs never go completely dark. Softer on the eyes in a dark room.") },
	{ { "comboBox_MoodLampLamp" }, QT_TRANSLATE_NOOP("Explanations", "Animation style of the mood lamp.") },
	{ { "radioButton_ConstantColorMoodLampMode", "pushButton_SelectColorMoodLamp" }, QT_TRANSLATE_NOOP("Explanations", "Keep one fixed color. Click the color button to choose it.") },
	{ { "radioButton_LiquidColorMoodLampMode", "horizontalSlider_MoodLampSpeed" }, QT_TRANSLATE_NOOP("Explanations", "Slowly cycle through the colors. The slider sets the speed.") },
	{ { "comboBox_SoundVizDevice" }, QT_TRANSLATE_NOOP("Explanations", "Which audio device to listen to. Pick the speakers or headphones you play music on.") },
	{ { "comboBox_SoundVizVisualizer" }, QT_TRANSLATE_NOOP("Explanations", "How the music is shown on the LEDs.") },
	{ { "radioButton_SoundVizConstantMode", "pushButton_SelectColorSoundVizMin", "pushButton_SelectColorSoundVizMax" }, QT_TRANSLATE_NOOP("Explanations", "Quiet sounds use the first color and loud sounds the second; in between, a blend of both.") },
	{ { "radioButton_SoundVizLiquidMode", "horizontalSlider_SoundVizLiquidSpeed" }, QT_TRANSLATE_NOOP("Explanations", "Colors keep changing on their own while reacting to the volume. The slider sets the speed.") },
	{ { "pushButton_EnableDisableDevice" }, QT_TRANSLATE_NOOP("Explanations", "Turn the LEDs on or off. Prismatik keeps running in the notification area.") },
	{ { "horizontalSlider_DeviceBrightness", "spinBox_DeviceBrightness" }, QT_TRANSLATE_NOOP("Explanations", "Overall brightness of the LEDs.") },
	{ { "horizontalSlider_DeviceBrightnessCap", "spinBox_DeviceBrightnessCap" }, QT_TRANSLATE_NOOP("Explanations", "Safety limit: no LED ever goes above this brightness, even on white scenes. Protects weak power supplies and keeps a white wall from becoming blinding.") },
	{ { "horizontalSlider_GammaCorrection", "doubleSpinBox_DeviceGamma" }, QT_TRANSLATE_NOOP("Explanations", "Corrects how the LEDs show mid-tones (LEDs are not linear like a screen). Raise it if colors look washed out, lower it if dark scenes look too dark.") },
	{ { "checkBox_EnableDithering" }, QT_TRANSLATE_NOOP("Explanations", "Quickly alternates between nearby brightness levels to fake finer steps. Smoother fades on very dark colors; may flicker on some strips.") },
	{ { "horizontalSlider_DeviceSmooth", "spinBox_DeviceSmooth" }, QT_TRANSLATE_NOOP("Explanations", "How gently the LEDs change from one color to the next. Higher = softer transitions but slower reaction.") },
	{ { "horizontalSlider_DeviceColorDepth", "spinBox_DeviceColorDepth" }, QT_TRANSLATE_NOOP("Explanations", "Number of brightness steps used by Lightpack devices. Higher = finer colors.") },
	{ { "horizontalSlider_DeviceRefreshDelay", "spinBox_DeviceRefreshDelay" }, QT_TRANSLATE_NOOP("Explanations", "How often a Lightpack device refreshes the LEDs. Lower = faster updates.") },
	{ { "checkBox_DisableUsbPowerLed" }, QT_TRANSLATE_NOOP("Explanations", "Turns off the small power indicator light on the Lightpack device.") },
	{ { "pbRunConfigurationWizard" }, QT_TRANSLATE_NOOP("Explanations", "Step-by-step setup: choose your device, the number of LEDs and where they sit around the screen. Run it when you install a new strip.") },
	{ { "checkBox_KeepLightsOnAfterExit" }, QT_TRANSLATE_NOOP("Explanations", "Leave the LEDs on with their last color when you close Prismatik.") },
	{ { "checkBox_KeepLightsOnAfterLockComputer" }, QT_TRANSLATE_NOOP("Explanations", "Keep the LEDs on while Windows is locked (Win+L).") },
	{ { "checkBox_KeepLightsOnAfterSuspend" }, QT_TRANSLATE_NOOP("Explanations", "Keep the LEDs on while the computer sleeps. Usually off, otherwise they stay lit in the dark.") },
	{ { "checkBox_KeepLightsOnAfterScreenOff" }, QT_TRANSLATE_NOOP("Explanations", "Keep the LEDs on when only the monitor turns off.") },
	{ { "comboBox_Profiles" }, QT_TRANSLATE_NOOP("Explanations", "A profile saves a complete set of settings (mode, brightness, zones). Create one per use, for example Movies and Gaming, and switch quickly here or from the tray icon.") },
	{ { "pushButton_ProfileNew" }, QT_TRANSLATE_NOOP("Explanations", "Create a new profile.") },
	{ { "pushButton_ProfileResetToDefault" }, QT_TRANSLATE_NOOP("Explanations", "Reset this profile to the default settings.") },
	{ { "pushButton_DeleteProfile" }, QT_TRANSLATE_NOOP("Explanations", "Delete this profile.") },
	{ { "commandLinkButton_OpenSettings" }, QT_TRANSLATE_NOOP("Explanations", "Open the profile file in a text editor (advanced).") },
	{ { "comboBox_Language" }, QT_TRANSLATE_NOOP("Explanations", "Language of Prismatik. System default follows Windows.") },
	{ { "pushButton_UpPriority", "pushButton_DownPriority" }, QT_TRANSLATE_NOOP("Explanations", "Plugins higher in the list win when two of them want to control the LEDs at the same time.") },
	{ { "pushButton_ReloadPlugins" }, QT_TRANSLATE_NOOP("Explanations", "Look for new or changed plugins in the Plugins folder.") },
	{ { "groupBox_Api" }, QT_TRANSLATE_NOOP("Explanations", "Lets other programs (Home Assistant, scripts, plugins) control the LEDs over the network. Leave it off unless you need it.") },
	{ { "checkBox_listenOnlyOnLoInterface" }, QT_TRANSLATE_NOOP("Explanations", "Accept connections only from this computer. Turn off only if another device on your network has to control the LEDs.") },
	{ { "lineEdit_ApiPort" }, QT_TRANSLATE_NOOP("Explanations", "Network port of the API server. Default: 3636.") },
	{ { "lineEdit_ApiKey", "pushButton_GenerateNewApiKey" }, QT_TRANSLATE_NOOP("Explanations", "Password other programs must send to use the API. Empty = no password.") },
	{ { "groupBox" }, QT_TRANSLATE_NOOP("Explanations", "How Prismatik reads your screen.") },
	{ { "radioButton_GrabWinAPI" }, QT_TRANSLATE_NOOP("Explanations", "Older method: the CPU copies the whole screen. Works everywhere, but is heavier and cannot see most exclusive-fullscreen games.") },
	{ { "radioButton_GrabDDupl" }, QT_TRANSLATE_NOOP("Explanations", "Recommended. Modern capture (Windows 8 and later) done by the graphics card: lighter, sees videos and most games, and supports fullscreen recovery and the Performance options.") },
	{ { "radioButton_GrabX11", "radioButton_GrabMacCoreGraphics", "radioButton_GrabMacAVFoundation" }, QT_TRANSLATE_NOOP("Explanations", "Screen capture method for this operating system.") },
	{ { "checkBox_EnableDx1011Capture" }, QT_TRANSLATE_NOOP("Explanations", "For games that stay black even with Desktop Duplication: reads the image from inside DirectX 10/11 games. Needs administrator rights. Do not use with online games that have anti-cheat: injecting into the game can get your account banned.") },
	{ { "checkBox_EnableDx9Capture" }, QT_TRANSLATE_NOOP("Explanations", "Same as above for old DirectX 9 games. High performance cost.") },
	{ { "spinBox_LoggingLevel" }, QT_TRANSLATE_NOOP("Explanations", "How much detail is written to the log files. 0 = off. Raise it only to investigate a problem (needs a restart).") },
	{ { "checkBox_PingDeviceEverySecond" }, QT_TRANSLATE_NOOP("Explanations", "Checks every second that a Lightpack device is still connected, to reconnect it automatically.") },
	{ { "checkBox_SendDataOnlyIfColorsChanges" }, QT_TRANSLATE_NOOP("Explanations", "Only send data to the LEDs when a color changes. Saves USB traffic, but some Adalight strips switch off after a few seconds without data: keep it off if your LEDs go dark on still images.") },
	{ { "checkBox_checkForUpdates" }, QT_TRANSLATE_NOOP("Explanations", "Check online for a newer Prismatik version at startup.") },
	{ { "checkBox_installUpdates" }, QT_TRANSLATE_NOOP("Explanations", "Download and install updates automatically.") },
	};
}

namespace Explanations
{

void apply(QWidget *root)
{
	if (!root)
		return;
	for (const Explanation &explanation : kExplanations) {
		const QString text = QCoreApplication::translate("Explanations", explanation.text);
		// wrapping in <p> makes Qt treat it as rich text, so long tooltips word-wrap
		const QString html = QStringLiteral("<p>%1</p>").arg(text.toHtmlEscaped());
		for (const char *name : explanation.widgets) {
			if (!name)
				continue;
			QWidget *widget = root->findChild<QWidget *>(QLatin1String(name));
			if (!widget)
				continue;
			widget->setToolTip(html);
			// keep the longer, hand-written help that some controls already have
			if (widget->whatsThis().isEmpty())
				widget->setWhatsThis(html);
		}
	}
}

} // namespace Explanations
