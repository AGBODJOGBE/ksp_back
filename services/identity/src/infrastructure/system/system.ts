import { v7 as uuidv7 } from 'uuid';
import { type Clock, type IdGenerator } from '../../application/shared/system.ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Identifiants UUID v7 : triables par date de création. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
