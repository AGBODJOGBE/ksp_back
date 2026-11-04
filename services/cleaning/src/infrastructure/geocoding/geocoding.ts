import { type GeocodingProvider } from '../../domain/location';

/** Échec d'un fournisseur (réseau, délai, réponse illisible) : la chaîne passe au suivant. */
export class GeocodingFailure extends Error {
  constructor(
    readonly provider: GeocodingProvider,
    readonly reason: string,
  ) {
    super(`${provider} : ${reason}`);
    this.name = 'GeocodingFailure';
  }
}

/** Noms non vides, sans doublon, dans l'ordre reçu. */
export function addressCandidates(values: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
