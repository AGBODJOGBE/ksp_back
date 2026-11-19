import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de PlanningAdminService — back-office : planning, affectations, planification
 * automatique (UC-NT-37, 38). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore
 * livrée répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.PlanningAdminServiceControllerMethods()
export class PlanningAdminGrpcController implements cleaningV1.PlanningAdminServiceController {
  getPlanning(): Promise<cleaningV1.GetPlanningResponse> {
    return notImplemented('GetPlanning');
  }

  listUnassigned(): Promise<cleaningV1.ListUnassignedResponse> {
    return notImplemented('ListUnassigned');
  }

  checkAssignment(): Promise<cleaningV1.CheckAssignmentResponse> {
    return notImplemented('CheckAssignment');
  }

  createAssignments(): Promise<cleaningV1.CreateAssignmentsResponse> {
    return notImplemented('CreateAssignments');
  }

  updateAssignment(): Promise<cleaningV1.UpdateAssignmentResponse> {
    return notImplemented('UpdateAssignment');
  }

  removeAssignment(): Promise<cleaningV1.RemoveAssignmentResponse> {
    return notImplemented('RemoveAssignment');
  }

  runAutoPlanning(): Promise<cleaningV1.RunAutoPlanningResponse> {
    return notImplemented('RunAutoPlanning');
  }

  listProposals(): Promise<cleaningV1.ListProposalsResponse> {
    return notImplemented('ListProposals');
  }

  approveProposals(): Promise<cleaningV1.ApproveProposalsResponse> {
    return notImplemented('ApproveProposals');
  }
}
