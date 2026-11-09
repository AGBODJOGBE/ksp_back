import { type GeocodedPlace } from '../domain/geocoding';
import { type GeoPoint } from '../domain/geo-point';
import { requirePoint } from './input';
import { type ReverseGeocoder } from './ports';

/** ReverseGeocode : noms de commune possibles et adresse lisible ; null si aucun fournisseur ne trouve. */
export class ReverseGeocodeUseCase {
  constructor(private readonly geocoder: ReverseGeocoder) {}

  async execute(input: { point?: Partial<GeoPoint> | undefined }): Promise<GeocodedPlace | null> {
    return this.geocoder.reverse(requirePoint('point', input.point));
  }
}
