-- ============================================================================
-- NEWPAD — Migration 0005 : tâches planifiées (pg_cron)
-- ============================================================================
-- pg_cron doit être activé sur le projet (Database > Extensions > pg_cron).
-- Toutes les fonctions appelées sont idempotentes à l'échelle de leur
-- fréquence (elles vérifient elles-mêmes la dernière exécution effective).

select cron.schedule('newpad-daily-fees', '0 3 * * *', $$select charge_account_fees();$$);
select cron.schedule('newpad-daily-interest', '10 3 * * *', $$select pay_savings_interest();$$);
select cron.schedule('newpad-loan-installments', '0 4 * * *', $$select process_due_loan_installments();$$);
select cron.schedule('newpad-cashier-report', '55 23 * * *', $$select generate_daily_cashier_report();$$);

-- Planification (heures serveur UTC) : frais de gestion 03h00, intérêts
-- épargne 03h10, échéances de prêts 04h00, rapport de caisse 23h55.
