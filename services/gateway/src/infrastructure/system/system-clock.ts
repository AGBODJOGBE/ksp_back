import { type Clock } from '../../application/access/access.ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
