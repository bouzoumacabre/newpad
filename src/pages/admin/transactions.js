import { renderAdminShell } from './shell.js';
import { renderTransactionsScreen } from '../shared/transactionsScreen.js';

export async function renderAdminTransactions(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'transactions');
  await renderTransactionsScreen(content, { canEdit: true });
}
