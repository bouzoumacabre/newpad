import { renderEmployeeShell } from './shell.js';
import { renderTransactionsScreen } from '../shared/transactionsScreen.js';

export async function renderEmployeeTransactions(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'transactions');
  await renderTransactionsScreen(content);
}
