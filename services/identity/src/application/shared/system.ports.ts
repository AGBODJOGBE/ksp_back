export interface Clock {
  now(): Date;
}

/** Identifiants UUID v7 (cahier des charges Identité, partie 7). */
export interface IdGenerator {
  next(): string;
}
