import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACTED_PATHS } from './logger';

/** Journal réel (pino) avec les chemins masqués : seule la sortie écrite compte. */
function written(entry: Record<string, unknown>): string {
  let output = '';
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });
  pino({ redact: { paths: REDACTED_PATHS, censor: '[masqué]' } }, sink).info(entry, 'test');
  return output;
}

describe('journaux : données masquées', () => {
  it('position, repère et adresses d’un lieu d’intervention ne sont jamais écrits (ADR-034)', () => {
    const line = written({
      request: {
        latitude: 6.3654,
        longitude: 2.4183,
        location: { latitude: 6.3654, longitude: 2.4183 },
        landmark: 'Portail vert',
        address: 'Lot 12',
        geocodedAddress: 'Place de l’Étoile rouge',
        displayAddress: 'Cotonou',
        serviceCode: 'home_cleaning',
      },
    });
    expect(line).not.toMatch(/6\.3654|2\.4183|Portail vert|Lot 12|Étoile|Cotonou/);
    expect(line).toContain('home_cleaning');
    expect(line).toContain('[masqué]');
  });

  it('jetons et secrets restent masqués', () => {
    const line = written({ body: { refreshToken: 'secret-1', code: '482913' } });
    expect(line).not.toMatch(/secret-1|482913/);
  });
});
