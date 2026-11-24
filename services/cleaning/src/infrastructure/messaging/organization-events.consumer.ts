import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps, type OrganizationDeps } from '../../application/deps';
import {
  OrganizationStandingUseCases,
  type StandingOutcome,
} from '../../application/organizations/standing.use-cases';

/**
 * Situation des organisations (partie 11.2 et 11.3, UC-NT-47, ADR-055) :
 * - billing.invoice.overdue et billing.invoice.paid (versions 1 et 2 ; billing publie la version 2
 *   pour une facture mensuelle) : compte des factures mensuelles impayées, avertissement,
 *   suspension et reprise des programmes de l'organisation (R-PE-06) ;
 * - identity.organization.suspended et identity.organization.reactivated : cause « organisation
 *   suspendue » posée ou levée sur ses programmes (R-SU-01, RV-85).
 * Seul abonné de ces quatre types dans le service (une file par consommateur et par type,
 * ADR-047). Chaque événement est traité dans une transaction, inbox comprise : un échec renvoie le
 * message en file de reprise, un événement rejoué ne change rien. Seuls des nombres sont
 * journalisés, jamais l'identifiant de l'organisation.
 */
@Injectable()
export class OrganizationEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrganizationEventsConsumer.name);
  private readonly standings: OrganizationStandingUseCases;

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
  ) {
    this.standings = new OrganizationStandingUseCases(deps as OrganizationDeps);
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const [type, event] of [
      ['billing.invoice.overdue', 'overdue'],
      ['billing.invoice.paid', 'paid'],
    ] as const) {
      await this.consumer.subscribe(
        type,
        async (envelope) => {
          const { invoiceId, organizationId, source, kind } = envelope.payload;
          const outcome = await this.standings.onInvoiceEvent({
            eventId: envelope.eventId,
            event,
            invoiceId,
            organizationId,
            source,
            kind: kind ?? null,
          });
          this.log(event === 'overdue' ? 'Facture mensuelle impayée' : 'Facture mensuelle soldée', outcome);
        },
        { versions: [1, 2] },
      );
    }
    for (const [type, decision] of [
      ['identity.organization.suspended', 'suspended'],
      ['identity.organization.reactivated', 'reactivated'],
    ] as const) {
      await this.consumer.subscribe(type, async (envelope) => {
        const outcome = await this.standings.onOrganizationDecision({
          eventId: envelope.eventId,
          decision,
          organizationId: envelope.payload.organizationId,
          occurredAt: new Date(envelope.occurredAt),
        });
        this.log(
          decision === 'suspended' ? 'Organisation suspendue par KSP' : 'Organisation réactivée par KSP',
          outcome,
        );
      });
    }
  }

  private log(label: string, outcome: StandingOutcome): void {
    if (outcome.status !== 'processed') return;
    this.logger.log(
      `${label} : ${outcome.unpaidCount} impayée(s), ${outcome.suspended} programme(s) suspendu(s), ` +
        `${outcome.resumed} repris, ${outcome.updated} cause(s) changée(s)` +
        (outcome.warned ? ', avertissement envoyé' : ''),
    );
  }
}
