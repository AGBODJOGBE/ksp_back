import { type FieldCipher, type GeoPoint } from '../../../application/ports';
import { type PlaceLocations } from '../../geo/geo-travel-times';
import { type PrismaService } from '../../prisma/prisma.service';
import { uuids } from '../agents/agent-rows';

/** Contexte de chiffrement de la position d'un lieu (à aligner sur le lot C, qui l'écrit). */
export const placeGpsContext = (placeId: string) => `place:${placeId}:gps`;

/**
 * Positions des lieux pour le calcul des trajets : places.gps_encrypted, chiffré par FieldCipher
 * sous la forme {"latitude","longitude"}. Position absente, effacée ou illisible : lieu absent
 * (le domaine applique alors le trajet par défaut). Jamais journalisée.
 */
export class PrismaPlaceLocations implements PlaceLocations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: FieldCipher,
  ) {}

  async points(placeIds: readonly string[]): Promise<Map<string, GeoPoint>> {
    const rows = await this.prisma.place.findMany({
      where: { id: { in: uuids(placeIds) }, gpsEncrypted: { not: null } },
      select: { id: true, gpsEncrypted: true },
    });
    const points = new Map<string, GeoPoint>();
    for (const row of rows) {
      try {
        const point = JSON.parse(this.cipher.decrypt(row.gpsEncrypted!, placeGpsContext(row.id))) as GeoPoint;
        if (Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) points.set(row.id, point);
      } catch {
        // Chiffré illisible : le lieu compte comme sans position.
      }
    }
    return points;
  }
}
