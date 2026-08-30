import { renderEmployeeShell } from './shell.js';
import { renderCashierScreen } from '../shared/cashierScreen.js';

export async function renderEmployeeCashier(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'cashier');
  await renderCashierScreen(content, profile, { canAdjust: false });
}
