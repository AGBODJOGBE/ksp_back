import { type AppError, type RequestContext, runWithContext } from '@ksp/platform';
import { TEST_SETTINGS, fakeDeps } from './testing/fakes';
import { createUseCases } from './use-cases';

const CREDITOR = '0192f1c4-0000-7000-8000-00000000c001';
const STRANGER = '0192f1c4-0000-7000-8000-00000000c009';
const CASE = { type: 'recovery_case', id: '0192f1c4-0000-7000-8000-00000000ca5e' };

const mandate = {
  caseReference: 'REC-2026-0042',
  creditor: { name: 'SARL Bénin Propre', kind: 'company', address: 'Rue 12, Cotonou' },
  debtor: { name: 'Koffi Mensah' },
  claim: { principal: 150000, cause: 'Facture de prestation n° 18 impayée' },
  fees: { successFeePercent: 12.5 },
  durationMonths: 6,
};

const agreement = {
  caseReference: 'REC-2026-0042',
  creditor: { name: 'SARL Bénin Propre' },
  debtor: { name: 'Koffi Mensah', phoneE164: '+2290197000045' },
  claim: { cause: 'Facture de prestation n° 18 impayée' },
  agreedTotal: 150000,
  installments: [
    { dueDate: '2026-12-05', amount: 50000 },
    { dueDate: '2027-01-05', amount: 50000 },
    { dueDate: '2027-02-05', amount: 50000 },
  ],
  paymentInstructions: 'Mobile Money au +2290190000000, référence REC-2026-0042.',
};

function as<T>(context: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ correlationId: 'test', ...context }, fn);
}
const service = (name = 'recovery') => ({ callerService: name });
const user = (userId: string) => ({
  user: { userId, sessionId: 's', activeContext: 'personal', roles: [], mfa: false },
  client: { ip: '197.234.10.20', userAgent: 'Mozilla/5.0 (Android 14)' },
});
const publicClient = { client: { ip: '197.234.10.21', userAgent: 'Mozilla/5.0 (iPhone)' } };

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Une erreur était attendue.');
}

function setup() {
  const deps = fakeDeps();
  const useCases = createUseCases(deps);
  const generate = (template: string, variables: unknown, key = 'gen-1', ownerId = CREDITOR) =>
    as(service(), () =>
      useCases.generateDocument.execute({
        template,
        variablesJson: JSON.stringify(variables),
        subject: CASE,
        ownerId,
        idempotencyKey: key,
      }),
    );
  /** Protocole demandé au débiteur sans compte : renvoie le jeton reçu par lien. */
  const requestDebtorSignature = async () => {
    const { document } = await generate('recovery_settlement_agreement', agreement, 'pac-1');
    const result = await as(service(), () =>
      useCases.requestSignature.execute({
        documentId: document.id,
        signer: { phoneE164: '+2290197000045', displayName: 'Koffi Mensah' },
        idempotencyKey: 'sign-1',
      }),
    );
    const link = deps.notifier.invitations.at(-1)!.link;
    return {
      document: result.view.document,
      request: result.signature.request,
      token: link.split('/').at(-1)!,
    };
  };
  return { deps, useCases, generate, requestDebtorSignature };
}

describe('GenerateDocument', () => {
  it('produit le PDF, le stocke rattaché au document et enregistre son empreinte', async () => {
    const { deps, generate } = setup();
    const { document, signature } = await generate('recovery_mandate', mandate);
    expect(document).toMatchObject({
      template: 'recovery_mandate',
      templateVersion: 1,
      title: 'Mandat de recouvrement',
      number: 'MAN-2026-000001',
      status: 'draft',
      ownerId: CREDITOR,
      producerService: 'recovery',
      subject: CASE,
    });
    expect(signature).toBeNull();
    const stored = deps.pdfs.files.get(document.fileId)!;
    expect(stored).toMatchObject({
      documentId: document.id,
      ownerId: CREDITOR,
      fileName: 'MAN-2026-000001.pdf',
    });
    expect(document.sha256).toBe(deps.secrets.sha256(stored.bytes));
    const content = deps.renderer.rendered[0]!;
    expect(content.dateLine).toBe('Fait à Cotonou, le 9 novembre 2026');
    expect(JSON.stringify(content.blocks)).toContain('150 000 FCFA');
  });

  it('est idempotent par la clé du service, et refuse la même clé pour un autre document', async () => {
    const { deps, generate } = setup();
    const first = await generate('recovery_mandate', mandate);
    const again = await generate('recovery_mandate', mandate);
    expect(again.document.id).toBe(first.document.id);
    expect(deps.pdfs.files.size).toBe(1);
    const error = await rejection(generate('recovery_formal_notice', {}, 'gen-1'));
    expect(error.code).toMatch(/DOCUMENT_(ALREADY_EXISTS|VARIABLES_INVALID)/);
  });

  it('refuse des variables invalides en ne citant que les chemins, jamais les valeurs', async () => {
    const { generate } = setup();
    const error = await rejection(
      generate('recovery_settlement_agreement', { ...agreement, agreedTotal: 149999, secret: 'x' }),
    );
    expect(error.code).toBe('DOCUMENT_VARIABLES_INVALID');
    expect(error.details).toEqual({ fields: expect.arrayContaining(['installments', '(racine)']) });
    expect(JSON.stringify(error.details)).not.toContain('149999');
  });

  it('modèle inconnu, modèle réservé à un autre service, gateway et modèle de test désactivé', async () => {
    const { deps, useCases, generate } = setup();
    expect((await rejection(generate('contrat_inconnu', {}))).code).toBe('DOCUMENT_TEMPLATE_UNKNOWN');
    const byCleaning = as(service('cleaning'), () =>
      useCases.generateDocument.execute({
        template: 'recovery_mandate',
        variablesJson: JSON.stringify(mandate),
        subject: CASE,
        idempotencyKey: 'k',
      }),
    );
    expect((await rejection(byCleaning)).code).toBe('DOCUMENT_CALLER_FORBIDDEN');
    const byGateway = as(service('gateway'), () =>
      useCases.generateDocument.execute({ template: 'generic' }),
    );
    expect((await rejection(byGateway)).code).toBe('DOCUMENT_CALLER_FORBIDDEN');
    const disabled = createUseCases({
      ...deps,
      settings: { ...TEST_SETTINGS, genericTemplateEnabled: false },
    });
    const generic = as(service(), () =>
      disabled.generateDocument.execute({
        template: 'generic',
        variablesJson: JSON.stringify({ title: 'Essai', paragraphs: ['Texte'] }),
        subject: CASE,
        idempotencyKey: 'k',
      }),
    );
    expect((await rejection(generic)).code).toBe('DOCUMENT_TEMPLATE_UNKNOWN');
  });
});

describe('RequestSignature', () => {
  it('envoie un lien personnel au signataire sans compte ; téléphone masqué, jeton gardé par empreinte', async () => {
    const { deps, requestDebtorSignature } = setup();
    const { document, request, token } = await requestDebtorSignature();
    expect(document.status).toBe('pending_signature');
    expect(request).toMatchObject({
      status: 'pending',
      signerUserId: null,
      signerPhoneMasked: '+229********45',
      signerName: 'Koffi Mensah',
      tokenHash: deps.secrets.hashToken(token),
    });
    expect(request.expiresAt.toISOString()).toBe('2026-11-16T10:00:00.000Z');
    const invitation = deps.notifier.invitations[0]!;
    expect(invitation.link).toBe(`https://ksp.bj/signer/${token}`);
    expect(invitation).toMatchObject({ firstName: 'Koffi', expiresOn: '16 novembre 2026' });
  });

  it('refuse la signature d’une mise en demeure, et une seconde demande en cours', async () => {
    const { useCases, generate, requestDebtorSignature } = setup();
    const notice = await generate(
      'recovery_formal_notice',
      {
        caseReference: 'REC-1',
        creditor: { name: 'SARL Bénin Propre' },
        debtor: { name: 'Koffi Mensah' },
        claim: { principal: 150000, cause: 'Facture impayée' },
        paymentDeadlineDays: 8,
        paymentInstructions: 'Mobile Money',
      },
      'med-1',
    );
    const refused = as(service(), () =>
      useCases.requestSignature.execute({
        documentId: notice.document.id,
        signer: { phoneE164: '+2290197000045', displayName: 'Koffi' },
        idempotencyKey: 's',
      }),
    );
    expect((await rejection(refused)).code).toBe('DOCUMENT_SIGNATURE_NOT_REQUIRED');

    const { document } = await requestDebtorSignature();
    const second = as(service(), () =>
      useCases.requestSignature.execute({
        documentId: document.id,
        signer: { phoneE164: '+2290197000046', displayName: 'Autre' },
        idempotencyKey: 'sign-2',
      }),
    );
    expect((await rejection(second)).code).toBe('DOCUMENT_INVALID_STATUS');
  });

  it('retire la demande si le message ne part pas, puis la refait avec la même clé', async () => {
    const { deps, useCases, generate } = setup();
    const { document } = await generate('recovery_settlement_agreement', agreement, 'pac-1');
    deps.notifier.fail = new Error('notification injoignable');
    const request = () =>
      as(service(), () =>
        useCases.requestSignature.execute({
          documentId: document.id,
          signer: { phoneE164: '+2290197000045', displayName: 'Koffi Mensah' },
          idempotencyKey: 'sign-1',
        }),
      );
    await expect(request()).rejects.toThrow('notification injoignable');
    expect((await deps.documents.findById(document.id))!.status).toBe('draft');
    expect(deps.documents.requests.size).toBe(0);
    deps.notifier.fail = null;
    const retried = await request();
    expect(retried.view.document.status).toBe('pending_signature');
    const replay = await request();
    expect(replay.signature.request.id).toBe(retried.signature.request.id);
    expect(deps.notifier.invitations).toHaveLength(1);
  });

  it('signataire titulaire d’un compte : coordonnées lues dans identity, code envoyé aussitôt', async () => {
    const { deps, useCases, generate } = setup();
    deps.users.users.set(CREDITOR, {
      firstName: 'Awa',
      lastName: 'Dossou',
      phoneE164: '+2290197000011',
      email: 'awa@exemple.bj',
    });
    const { document } = await generate('recovery_mandate', mandate);
    const result = await as(service(), () =>
      useCases.requestSignature.execute({
        documentId: document.id,
        signer: { userId: CREDITOR },
        notice: 'code',
        idempotencyKey: 'sign-1',
      }),
    );
    expect(result.signature.request).toMatchObject({
      signerUserId: CREDITOR,
      signerName: 'Awa Dossou',
      signerPhoneE164: null,
      tokenHash: null,
    });
    expect(result.signature.codeExpiresAt?.toISOString()).toBe('2026-11-09T10:10:00.000Z');
    expect(deps.notifier.codes[0]).toMatchObject({
      contact: { userId: CREDITOR, phoneE164: '+2290197000011', email: 'awa@exemple.bj' },
      documentTitle: 'Mandat de recouvrement',
    });
  });
});

describe('Signature par lien (signataire sans compte)', () => {
  it('aperçu, code, essais limités, puis signature avec preuve, certificat et événement', async () => {
    const { deps, useCases, requestDebtorSignature } = setup();
    const { document, token } = await requestDebtorSignature();
    const session = await as(publicClient, () => useCases.linkSignature.session(token));
    expect(session).toMatchObject({ documentNumber: 'PAC-2026-000001', status: 'pending' });
    expect(session.download).toMatchObject({
      version: 'original',
      url: `https://stockage.test/${document.fileId}`,
    });

    deps.secrets.nextCodes.push('482913');
    const delivery = await as(publicClient, () => useCases.linkSignature.sendCode(token));
    expect(delivery).toMatchObject({ channel: 'whatsapp', resendAfterSeconds: 60 });
    expect(deps.notifier.codes[0]).toMatchObject({
      code: '482913',
      contact: { phoneE164: '+2290197000045' },
    });
    const tooSoon = await rejection(as(publicClient, () => useCases.linkSignature.sendCode(token)));
    expect(tooSoon.code).toBe('DOCUMENT_CODE_TOO_SOON');

    const noConsent = await rejection(
      as(publicClient, () => useCases.linkSignature.sign({ token, code: '482913', consent: false })),
    );
    expect(noConsent.code).toBe('DOCUMENT_CONSENT_REQUIRED');
    const wrong = await rejection(
      as(publicClient, () => useCases.linkSignature.sign({ token, code: '000000', consent: true })),
    );
    expect(wrong).toMatchObject({ code: 'DOCUMENT_CODE_INVALID', details: { attemptsLeft: 4 } });

    deps.clock.advance(30_000);
    const signed = await as(publicClient, () =>
      useCases.linkSignature.sign({ token, code: '482 913', consent: true }),
    );
    expect(signed).toMatchObject({ status: 'signed', download: { version: 'signed' } });
    const after = (await deps.documents.findById(document.id))!;
    expect(after.status).toBe('signed');
    const sealed = deps.pdfs.files.get(after.signedFileId!)!;
    expect(new TextDecoder().decode(sealed.bytes)).toContain('CERT:PAC-2026-000001');
    expect(sealed.fileName).toBe('PAC-2026-000001-signe.pdf');

    const [completion] = deps.documents.completions;
    expect(completion!.evidence).toMatchObject({
      method: 'one_time_code',
      channel: 'whatsapp',
      signerUserId: null,
      signerName: 'Koffi Mensah',
      signerPhoneMasked: '+229********45',
      ip: '197.234.10.21',
      userAgent: 'Mozilla/5.0 (iPhone)',
      documentSha256: document.sha256,
      signedSha256: after.signedSha256,
      consent: true,
    });
    expect(completion!.event).toEqual({
      documentId: document.id,
      signatureRequestId: completion!.requestId,
      template: 'recovery_settlement_agreement',
      templateVersion: 1,
      producerService: 'recovery',
      subjectType: CASE.type,
      subjectId: CASE.id,
      ownerId: CREDITOR,
      signerUserId: null,
      method: 'one_time_code',
      channel: 'whatsapp',
      documentSha256: document.sha256,
      signedFileId: after.signedFileId,
      signedDocumentSha256: after.signedSha256,
      signedAt: '2026-11-09T10:00:30.000Z',
    });
    // Le certificat cite l'empreinte, le téléphone masqué, l'adresse IP ; jamais le numéro en clair.
    const certificate = JSON.stringify(deps.renderer.rendered.at(-1));
    expect(certificate).toContain(document.sha256);
    expect(certificate).toContain('+229********45');
    expect(certificate).toContain('197.234.10.21');
    expect(certificate).not.toContain('+2290197000045');
    // Coordonnées en clair effacées à la clôture.
    expect(deps.documents.requests.get(completion!.requestId)).toMatchObject({ signerPhoneE164: null });

    const again = await rejection(
      as(publicClient, () => useCases.linkSignature.sign({ token, code: '482913', consent: true })),
    );
    expect(again).toMatchObject({ code: 'DOCUMENT_SIGNATURE_CLOSED', details: { status: 'signed' } });
  });

  it('refuse de signer un PDF dont l’empreinte a changé', async () => {
    const { deps, useCases, requestDebtorSignature } = setup();
    const { document, token } = await requestDebtorSignature();
    await as(publicClient, () => useCases.linkSignature.sendCode(token));
    deps.pdfs.files.get(document.fileId)!.bytes = new TextEncoder().encode('PDF modifié');
    const error = await rejection(
      as(publicClient, () => useCases.linkSignature.sign({ token, code: '111111', consent: true })),
    );
    expect(error.code).toBe('DOCUMENT_CONTENT_CHANGED');
    expect((await deps.documents.findById(document.id))!.status).toBe('pending_signature');
  });

  it('code épuisé après 5 essais, jeton inconnu introuvable', async () => {
    const { useCases, requestDebtorSignature } = setup();
    const { token } = await requestDebtorSignature();
    await as(publicClient, () => useCases.linkSignature.sendCode(token));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await rejection(
        as(publicClient, () => useCases.linkSignature.sign({ token, code: '999999', consent: true })),
      );
    }
    const exhausted = await rejection(
      as(publicClient, () => useCases.linkSignature.sign({ token, code: '111111', consent: true })),
    );
    expect(exhausted.code).toBe('DOCUMENT_CODE_EXPIRED');
    const unknown = await rejection(as(publicClient, () => useCases.linkSignature.session('x'.repeat(43))));
    expect(unknown.code).toBe('DOCUMENT_SIGNATURE_NOT_FOUND');
  });

  it('demande expirée : plus d’aperçu ni de code, document expiré, nouvelle demande possible', async () => {
    const { deps, useCases, requestDebtorSignature } = setup();
    const { document, token } = await requestDebtorSignature();
    deps.clock.advance(169 * 3_600_000);
    const session = await as(publicClient, () => useCases.linkSignature.session(token));
    expect(session).toMatchObject({ status: 'expired', download: null });
    const closed = await rejection(as(publicClient, () => useCases.linkSignature.sendCode(token)));
    expect(closed).toMatchObject({ code: 'DOCUMENT_SIGNATURE_CLOSED', details: { status: 'expired' } });
    expect((await deps.documents.findById(document.id))!.status).toBe('expired');
    const renewed = await as(service(), () =>
      useCases.requestSignature.execute({
        documentId: document.id,
        signer: { phoneE164: '+2290197000045', displayName: 'Koffi Mensah' },
        idempotencyKey: 'sign-2',
      }),
    );
    expect(renewed.view.document.status).toBe('pending_signature');
  });
});

describe('Espace connecté', () => {
  it('le signataire connecté signe ; un autre compte ne voit ni la demande ni le document', async () => {
    const { deps, useCases, generate } = setup();
    deps.users.users.set(CREDITOR, {
      firstName: 'Awa',
      lastName: 'Dossou',
      phoneE164: null,
      email: 'awa@exemple.bj',
    });
    const { document } = await generate('recovery_mandate', mandate);
    const { signature } = await as(service(), () =>
      useCases.requestSignature.execute({
        documentId: document.id,
        signer: { userId: CREDITOR },
        idempotencyKey: 's',
      }),
    );
    expect(deps.notifier.invitations[0]!.link).toBe(`https://ksp.bj/mon-espace/documents/${document.id}`);
    const requestId = signature.request.id;

    const stranger = await rejection(as(user(STRANGER), () => useCases.userSignature.sendCode(requestId)));
    expect(stranger.code).toBe('DOCUMENT_SIGNATURE_NOT_FOUND');
    expect((await rejection(as(user(STRANGER), () => useCases.myDocuments.get(document.id)))).code).toBe(
      'DOCUMENT_NOT_FOUND',
    );

    deps.secrets.nextCodes.push('246810');
    const delivery = await as(user(CREDITOR), () => useCases.userSignature.sendCode(requestId));
    expect(delivery.channel).toBe('email');
    const view = await as(user(CREDITOR), () =>
      useCases.userSignature.sign({ requestId, code: '246810', consent: true }),
    );
    expect(view.document.status).toBe('signed');
    expect(view.signature?.status).toBe('signed');
    expect(deps.documents.completions[0]!.evidence).toMatchObject({
      signerUserId: CREDITOR,
      channel: 'email',
      ip: '197.234.10.20',
    });
    const download = await as(user(CREDITOR), () => useCases.myDocuments.downloadUrl(document.id));
    expect(download.version).toBe('signed');
  });
});

describe('Annulation, clôture et compte supprimé', () => {
  it('annule un document en attente (lien inutilisable), jamais un document signé', async () => {
    const { useCases, requestDebtorSignature } = setup();
    const { document, token } = await requestDebtorSignature();
    const cancelled = await as(service(), () =>
      useCases.cancelDocument.execute({ documentId: document.id, reason: 'Accord trouvé autrement' }),
    );
    expect(cancelled.document.status).toBe('cancelled');
    expect(cancelled.signature?.status).toBe('cancelled');
    const closed = await rejection(as(publicClient, () => useCases.linkSignature.sendCode(token)));
    expect(closed.code).toBe('DOCUMENT_SIGNATURE_CLOSED');
    const session = await as(publicClient, () => useCases.linkSignature.session(token));
    expect(session.download).toBeNull();
    const again = await as(service(), () => useCases.cancelDocument.execute({ documentId: document.id }));
    expect(again.document.status).toBe('cancelled');
    const otherService = await rejection(
      as(service('cleaning'), () => useCases.cancelDocument.execute({ documentId: document.id })),
    );
    expect(otherService.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('clôt les demandes expirées par lots et détache un compte supprimé', async () => {
    const { deps, useCases, generate, requestDebtorSignature } = setup();
    await requestDebtorSignature();
    deps.clock.advance(200 * 3_600_000);
    expect(await useCases.expireSignatures.execute()).toEqual({ expired: 1 });
    expect(await useCases.expireSignatures.execute()).toEqual({ expired: 0 });

    deps.users.users.set(CREDITOR, {
      firstName: 'Awa',
      lastName: 'Dossou',
      phoneE164: '+2290197000011',
      email: null,
    });
    const { document } = await generate('recovery_mandate', mandate, 'man-2');
    await as(service(), () =>
      useCases.requestSignature.execute({
        documentId: document.id,
        signer: { userId: CREDITOR },
        idempotencyKey: 's',
      }),
    );
    const erased = await useCases.eraseAccount.execute({ eventId: 'evt-1', userId: CREDITOR });
    expect(erased).toEqual({ status: 'processed', detachedDocuments: 2, cancelledRequests: 1 });
    expect((await deps.documents.findById(document.id))!).toMatchObject({ ownerId: null, status: 'draft' });
    expect((await useCases.eraseAccount.execute({ eventId: 'evt-1', userId: CREDITOR })).status).toBe(
      'duplicate',
    );
  });
});
