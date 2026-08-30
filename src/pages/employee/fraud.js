import { renderEmployeeShell } from './shell.js';
import { renderFraudScreen } from '../shared/fraudScreen.js';

export async function renderEmployeeFraud(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'fraud');
  await renderFraudScreen(content, profile, '/employee/fraud');
}
