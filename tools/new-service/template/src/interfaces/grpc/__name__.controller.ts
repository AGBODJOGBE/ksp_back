import { __camelName__V1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';

/**
 * Adaptateur gRPC : traduit chaque appel en cas d'usage (couche application).
 * Aucune règle métier ici.
 */
@Controller()
@__camelName__V1.__Name__ServiceControllerMethods()
export class __Name__GrpcController implements __camelName__V1.__Name__ServiceController {}
