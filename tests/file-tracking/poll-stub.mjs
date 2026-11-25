export const GlobalConfig = Object.freeze({projects:[]});
export function takeScreenShot() { throw new Error('QA did not authorize desktop commands'); }
export const mouseClick = takeScreenShot;
export const moveMouse = takeScreenShot;
export const keyboardSendKey = takeScreenShot;
export const keyboardSendText = takeScreenShot;
export const mouseScroll = takeScreenShot;
export const screenshotToClipboard = takeScreenShot;
export const DesktopActions = Object.freeze({scroll:takeScreenShot,drag:takeScreenShot,screenshotToClipboard:takeScreenShot});
export const DesktopCommands = Object.freeze({windowList:takeScreenShot,windowActivate:takeScreenShot,windowSetBounds:takeScreenShot,mouseDoubleClick:takeScreenShot,clipboardGetText:takeScreenShot,clipboardSetText:takeScreenShot});
