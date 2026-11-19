import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Couche Nettoyage produite depuis les contrats (tools/gateway/cleaning-routes.ts) : manifeste,
 * validation et appels gRPC doivent correspondre au contrat OpenAPI et à cleaning.proto en vigueur.
 * Un contrat modifié sans relancer « pnpm gateway:routes » fait échouer ce test.
 */
describe('couche Nettoyage produite depuis les contrats', () => {
  it('les fichiers produits sont à jour', () => {
    const root = resolve(__dirname, '..', '..', '..');
    const run = () =>
      execFileSync(
        process.execPath,
        [require.resolve('tsx/cli'), 'tools/gateway/cleaning-routes.ts', '--check'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
    expect(run).not.toThrow();
  }, 60_000);
});
