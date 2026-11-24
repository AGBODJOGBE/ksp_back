import { AgentAdminGrpcController } from './agent-admin.controller';
import { AgentGrpcController } from './agent.controller';
import { CatalogAdminGrpcController } from './catalog-admin.controller';
import { CatalogGrpcController } from './catalog.controller';
import { ClaimAdminGrpcController } from './claim-admin.controller';
import { ObligationGrpcController } from './obligation.controller';
import { PlaceGrpcController } from './place.controller';
import { PlanningAdminGrpcController } from './planning-admin.controller';
import { ProgramAdminGrpcController } from './program-admin.controller';
import { ProgramGrpcController } from './program.controller';
import { RequestAdminGrpcController } from './request-admin.controller';
import { RequestGrpcController } from './request.controller';
import { SettingsAdminGrpcController } from './settings-admin.controller';
import { WalletDebitCheckGrpcController } from './wallet-debit-check.controller';

/**
 * Un contrôleur par service gRPC exposé par cleaning : les treize services de ksp.cleaning.v1,
 * plus ksp.common.v1.ObligationService.
 */
export const CLEANING_GRPC_CONTROLLERS = [
  CatalogGrpcController,
  PlaceGrpcController,
  RequestGrpcController,
  ProgramGrpcController,
  AgentGrpcController,
  CatalogAdminGrpcController,
  RequestAdminGrpcController,
  AgentAdminGrpcController,
  PlanningAdminGrpcController,
  ProgramAdminGrpcController,
  ClaimAdminGrpcController,
  SettingsAdminGrpcController,
  WalletDebitCheckGrpcController,
  ObligationGrpcController,
];
