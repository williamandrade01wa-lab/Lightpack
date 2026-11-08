/*
 * Explanations.hpp
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

#pragma once

class QWidget;

namespace Explanations
{
	// Sets a plain-language tooltip (and "What's this?" help where none exists)
	// on every known settings control below `root`. Call again after
	// retranslateUi(), which resets the designer tooltips.
	void apply(QWidget *root);
}
