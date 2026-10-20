/* placement.js — where the buttons sit in the top bar. No shell imports: prefs and tests use it. */

// GNOME's three boxes, and the middle of the left half: the left box, with the buttons pushed right.
export const BOXES = ['left', 'center', 'right', 'left-middle'];
export const BOX_TITLES = ['Left', 'Center', 'Right', 'Middle of the left half'];

/** The box GNOME has for a setting (it knows only left, center and right). */
export function shellBox(box) {
    if (box === 'left-middle')
        return 'left';
    return BOXES.includes(box) ? box : 'right';
}

/**
 * The left margin that centres buttons `ownWidth` wide on the middle of the bar's left half,
 * after `widthBefore` of what already sits in the left box (Activities). Never negative.
 */
export function leftHalfMargin(panelWidth, widthBefore, ownWidth) {
    return Math.max(0, Math.round(panelWidth / 4 - widthBefore - ownWidth / 2));
}
