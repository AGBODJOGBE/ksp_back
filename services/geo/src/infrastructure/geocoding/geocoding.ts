import { type GeocodingProvider } from '../../domain/geocoding';

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
