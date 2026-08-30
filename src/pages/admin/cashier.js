import { renderAdminShell } from './shell.js';
import { renderCashierScreen } from '../shared/cashierScreen.js';

export async function renderAdminCashier(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'cashier');
  await renderCashierScreen(content, profile, { canAdjust: true });
}
