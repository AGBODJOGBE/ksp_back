import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import {
  CheckAssignmentUseCase,
  CreateAssignmentsUseCase,
  RemoveAssignmentUseCase,
  UpdateAssignmentUseCase,
} from '../../application/planning/assignment.use-cases';
import { PlanningViewUseCases } from '../../application/planning/planning-view.use-cases';
import { notImplemented } from './not-implemented';
import { toAgentCheck, toAgentLoad, toAssignmentBatch, toPlanningItem } from './planning-mappers';

/**
 * Adaptateur gRPC de PlanningAdminService — back-office : planning et affectations manuelles
 * (UC-NT-37, lot D). La planification automatique (UC-NT-38) relève du lot G et répond encore
 * NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.PlanningAdminServiceControllerMethods()
export class PlanningAdminGrpcController implements cleaningV1.PlanningAdminServiceController {
  private readonly view: PlanningViewUseCases;
  private readonly check: CheckAssignmentUseCase;
  private readonly create: CreateAssignmentsUseCase;
  private readonly update: UpdateAssignmentUseCase;
  private readonly remove: RemoveAssignmentUseCase;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.view = new PlanningViewUseCases(deps);
    this.check = new CheckAssignmentUseCase(deps);
    this.create = new CreateAssignmentsUseCase(deps);
    this.update = new UpdateAssignmentUseCase(deps);
    this.remove = new RemoveAssignmentUseCase(deps);
  }

  async getPlanning(request: cleaningV1.GetPlanningRequest): Promise<cleaningV1.GetPlanningResponse> {
    const planning = await this.view.planning(request);
    return {
      planning: {
        from: planning.from.toISOString(),
        to: planning.to.toISOString(),
        items: planning.items.map(toPlanningItem),
        loads: planning.loads.map(toAgentLoad),
      },
    };
  }

  async listUnassigned(
    request: cleaningV1.ListUnassignedRequest,
  ): Promise<cleaningV1.ListUnassignedResponse> {
    const page = await this.view.unassigned(request);
    return { items: page.items.map(toPlanningItem), nextCursor: page.nextCursor ?? '', total: page.total };
  }

  async checkAssignment(
    request: cleaningV1.CheckAssignmentRequest,
  ): Promise<cleaningV1.CheckAssignmentResponse> {
    const report = await this.check.execute(request);
    return { assignmentCheckReport: { passed: report.passed, checks: report.checks.map(toAgentCheck) } };
  }

  async createAssignments(
    request: cleaningV1.CreateAssignmentsRequest,
  ): Promise<cleaningV1.CreateAssignmentsResponse> {
    return { assignmentBatch: toAssignmentBatch(await this.create.execute(request)) };
  }

  async updateAssignment(
    request: cleaningV1.UpdateAssignmentRequest,
  ): Promise<cleaningV1.UpdateAssignmentResponse> {
    const batch = await this.update.execute({
      assignmentId: request.assignmentId,
      replaceWithAgentId: request.replaceWithAgentId ?? null,
      isLead: request.isLead ?? null,
      overrides: request.overrides?.items ?? null,
      reason: request.reason,
    });
    return { assignmentBatch: toAssignmentBatch(batch) };
  }

  async removeAssignment(
    request: cleaningV1.RemoveAssignmentRequest,
  ): Promise<cleaningV1.RemoveAssignmentResponse> {
    await this.remove.execute(request);
    return {};
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
