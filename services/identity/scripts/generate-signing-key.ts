/**
 * Génère une nouvelle clé de signature ES256 au format attendu par IDENTITY_SIGNING_KEYS (ADR-020).
 *   pnpm --filter @ksp/identity-service keys:generate [kid]
 * La clé sort avec le statut "next" : à ajouter au secret, puis à rendre active lors de la rotation.
 * La sortie contient une clé privée : la copier directement dans le coffre, jamais dans un fichier versionné.
 */
import { exportPKCS8, generateKeyPair } from 'jose';

async function main(): Promise<void> {
  const kid = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const entry = { kid, status: 'next', privateKeyPem: await exportPKCS8(privateKey) };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

void main();
