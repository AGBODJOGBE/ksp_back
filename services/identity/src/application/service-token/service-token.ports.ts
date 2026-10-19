/** Un service autorisé à demander des jetons (ADR-022), d'après la carte des services. */
export interface ServiceClient {
  clientId: string;
  /** Services que ce client a le droit d'appeler. */
  audiences: string[];
}

export interface ServiceClientRegistry {
  /** Le client si le secret correspond, sinon null (comparaison en temps constant). */
  authenticate(clientId: string, clientSecret: string): ServiceClient | null;
}
