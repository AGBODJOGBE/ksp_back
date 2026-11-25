import { Injectable } from '@nestjs/common';
import {
  type DebtorAccessEvent,
  type DebtorAccessJournal,
} from '../../application/debtor-access/debtor-access.ports';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';

/** Référence des lignes du journal écrites par l'accès du débiteur : le lien concerné. */
const REF_TYPE = 'debtor_access';

/**
 * Journal de preuve du dossier (R-PR-08, table en ajout seul) pour les actions de l'accès du
 * débiteur : identifiants, canal et résumé, jamais de coordonnée, de jeton ni de code. Port propre à
 * l'accès du débiteur, à réunir avec le journal des dossiers.
 */
@Injectable()
export class PrismaDebtorAccessJournal implements DebtorAccessJournal {
  private readonly ids = new UuidV7Generator();

  constructor(private readonly prisma: PrismaService) {}

  async record(event: DebtorAccessEvent): Promise<void> {
    await this.prisma.evidenceEntry.create({
      data: {
        id: this.ids.next(),
        caseId: event.caseId,
        occurredAt: event.occurredAt,
        actorType: event.actorType,
        actorId: event.actorId,
        action: event.action,
        channel: event.channel,
        summary: event.summary,
        refType: REF_TYPE,
        refId: event.accessId,
      },
    });
  }
}
