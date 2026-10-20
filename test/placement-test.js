#!/usr/bin/env gjs -m
// Tests for the top-bar placement maths. Run: gjs -m test/placement-test.js
import { BOXES, BOX_TITLES, leftHalfMargin, shellBox } from '../claude-usage@aidan.local/placement.js';

let failures = 0;
function check(name, cond) {
    if (cond) {
        print(`  ok   ${name}`);
    } else {
        failures++;
        print(`  FAIL ${name}`);
    }
}

check('the middle of the left half is the left box to GNOME',
    shellBox('left-middle') === 'left' && shellBox('center') === 'center' && shellBox('nonsense') === 'right');
check('every box has a title', BOXES.length === BOX_TITLES.length);
check('buttons are centred a quarter of the way along the bar',
    leftHalfMargin(1920, 100, 200) === 1920 / 4 - 100 - 100);
check('a narrow bar never gives a negative margin', leftHalfMargin(400, 150, 200) === 0);

print(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
if (failures)
    imports.system.exit(1);
