import { getAppHomePaths, type Clock } from '../core/app-config';
import { buildLaunchPlan, formatLaunchDryRun, type LaunchPlan, type LaunchPlanOptions } from '../core/launcher';
import {
  clearDefaultProfile,
  copyProfile,
  listProfilesForDisplay,
  removeProfile,
  renameProfile,
  setDefaultProfile,
  type CopyProfileOptions,
  type CopyProfileResult,
  type DefaultProfileOptions,
  type ProfileSummary,
  type RemoveProfileOptions,
  type RemoveProfileResult,
  type RenameProfileOptions,
  type RenameProfileResult,
  type SetDefaultProfileOptions,
} from '../core/profile-management';
import { validateProfile, type ProfileValidationResult, type ValidateProfileOptions } from '../core/validator';

export type TuiAction =
  | 'list'
  | 'copy'
  | 'rename'
  | 'remove'
  | 'set-default'
  | 'clear-default'
  | 'show'
  | 'validate'
  | 'launch-dry-run'
  | 'exit';

export type TuiChoice = {
  value: TuiAction;
  label: string;
};

export type TuiPorts = {
  writeOut: (value: string) => void;
  select: (prompt: string, choices: TuiChoice[]) => Promise<string>;
  input: (prompt: string) => Promise<string>;
  confirmByName: (name: string, prompt: string) => Promise<string>;
};

export type TuiControllerServices = {
  listProfilesForDisplay: (options: { appHomePath?: string }) => Promise<ProfileSummary[]>;
  copyProfile: (options: CopyProfileOptions) => Promise<CopyProfileResult>;
  renameProfile: (options: RenameProfileOptions) => Promise<RenameProfileResult>;
  removeProfile: (options: RemoveProfileOptions) => Promise<RemoveProfileResult>;
  setDefaultProfile: (options: SetDefaultProfileOptions) => Promise<string>;
  clearDefaultProfile: (options: DefaultProfileOptions) => Promise<void>;
  validateProfile: (options: ValidateProfileOptions) => Promise<ProfileValidationResult>;
  buildLaunchPlan: (options: LaunchPlanOptions) => Promise<LaunchPlan>;
  formatLaunchDryRun: (plan: LaunchPlan) => string;
};

export type RunTuiControllerOptions = {
  appHomePath?: string;
  ports: TuiPorts;
  services?: Partial<TuiControllerServices>;
  clock?: Clock;
};

const actionChoices: TuiChoice[] = [
  { value: 'list', label: 'List profiles' },
  { value: 'copy', label: 'Copy profile' },
  { value: 'rename', label: 'Rename profile' },
  { value: 'remove', label: 'Remove profile' },
  { value: 'set-default', label: 'Set default profile' },
  { value: 'clear-default', label: 'Clear default profile' },
  { value: 'show', label: 'Show profile details' },
  { value: 'validate', label: 'Validate profile' },
  { value: 'launch-dry-run', label: 'Launch dry-run' },
  { value: 'exit', label: 'Exit' },
];

const defaultServices: TuiControllerServices = {
  listProfilesForDisplay,
  copyProfile,
  renameProfile,
  removeProfile,
  setDefaultProfile,
  clearDefaultProfile,
  validateProfile,
  buildLaunchPlan,
  formatLaunchDryRun,
};

export async function runTuiController(options: RunTuiControllerOptions): Promise<void> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const ports = options.ports;
  const services = { ...defaultServices, ...options.services };
  const clock = options.clock ?? (() => new Date());

  const profiles = await services.listProfilesForDisplay({ appHomePath });
  if (profiles.length === 0) {
    ports.writeOut('No profiles found.\n');
    ports.writeOut('Next: ccps init or ccps create <name> --template blank\n');
    return;
  }

  writeProfiles(ports, profiles);

  while (true) {
    const action = await ports.select('Choose an action', actionChoices);
    if (action === 'exit') {
      ports.writeOut('Exit.\n');
      return;
    }

    await runAction(action, { appHomePath, ports, services, clock });
  }
}

type ActionContext = {
  appHomePath: string;
  ports: TuiPorts;
  services: TuiControllerServices;
  clock: Clock;
};

async function runAction(action: string, context: ActionContext): Promise<void> {
  switch (action) {
    case 'list':
      writeProfiles(context.ports, await context.services.listProfilesForDisplay({ appHomePath: context.appHomePath }));
      return;
    case 'copy':
      await copyProfileAction(context);
      return;
    case 'rename':
      await renameProfileAction(context);
      return;
    case 'remove':
      await removeProfileAction(context);
      return;
    case 'set-default':
      await setDefaultAction(context);
      return;
    case 'clear-default':
      await clearDefaultAction(context);
      return;
    case 'show':
      await showProfileAction(context);
      return;
    case 'validate':
      await validateProfileAction(context);
      return;
    case 'launch-dry-run':
      await launchDryRunAction(context);
      return;
    default:
      context.ports.writeOut(`Unknown action: ${action}\n`);
  }
}

function writeProfiles(ports: TuiPorts, profiles: ProfileSummary[]): void {
  ports.writeOut('Profiles\n');
  ports.writeOut('Name\tStatus\tDefault\tLast Used\tDescription\n');

  for (const profile of profiles) {
    const defaultMarker = profile.isDefault ? 'default' : '-';
    const lastUsedMarker = profile.isLastUsed ? 'last-used' : '-';
    ports.writeOut(
      `${profile.name}\t${profile.status}\t${defaultMarker}\t${lastUsedMarker}\t${profile.description}\n`,
    );
  }
}

async function copyProfileAction(context: ActionContext): Promise<void> {
  const from = await context.ports.input('Source profile: ');
  const to = await context.ports.input('Target profile: ');
  const result = await context.services.copyProfile({
    appHomePath: context.appHomePath,
    from,
    to,
    clock: context.clock,
  });

  context.ports.writeOut(`Copied profile "${result.sourceName}" to "${result.targetName}".\n`);
  context.ports.writeOut(`Target: ${result.targetPath}\n`);
}

async function renameProfileAction(context: ActionContext): Promise<void> {
  const oldName = await context.ports.input('Old profile name: ');
  const newName = await context.ports.input('New profile name: ');
  const result = await context.services.renameProfile({
    appHomePath: context.appHomePath,
    oldName,
    newName,
    clock: context.clock,
  });

  context.ports.writeOut(`Renamed profile "${result.oldName}" to "${result.newName}".\n`);
  context.ports.writeOut(`Path: ${result.newPath}\n`);
}

async function removeProfileAction(context: ActionContext): Promise<void> {
  const name = await context.ports.input('Profile to remove: ');
  const confirmation = await context.ports.confirmByName(
    name,
    `Type the exact profile name to remove "${name}": `,
  );
  const result = await context.services.removeProfile({
    appHomePath: context.appHomePath,
    name,
    confirmation,
    clock: context.clock,
  });

  context.ports.writeOut(`Removed profile "${result.profileName}".\n`);
  context.ports.writeOut(`Backup: ${result.backupPath}\n`);
}

async function setDefaultAction(context: ActionContext): Promise<void> {
  const name = await context.ports.input('Default profile: ');
  const defaultProfile = await context.services.setDefaultProfile({
    appHomePath: context.appHomePath,
    name,
    clock: context.clock,
  });

  context.ports.writeOut(`Default profile set: ${defaultProfile}\n`);
}

async function clearDefaultAction(context: ActionContext): Promise<void> {
  await context.services.clearDefaultProfile({
    appHomePath: context.appHomePath,
    clock: context.clock,
  });

  context.ports.writeOut('Default profile cleared.\n');
}

async function showProfileAction(context: ActionContext): Promise<void> {
  const name = await context.ports.input('Profile to show: ');
  const validation = await context.services.validateProfile({
    appHomePath: context.appHomePath,
    name,
  });

  writeProfileDetails(context.ports, validation);
}

async function validateProfileAction(context: ActionContext): Promise<void> {
  const name = await context.ports.input('Profile to validate: ');
  const validation = await context.services.validateProfile({
    appHomePath: context.appHomePath,
    name,
  });

  context.ports.writeOut(`Profile: ${validation.profileName}\n`);
  context.ports.writeOut(`Status: ${validation.status}\n`);
  writeFindings(context.ports, validation);
}

async function launchDryRunAction(context: ActionContext): Promise<void> {
  const profileInput = await context.ports.input('Profile for dry-run (blank for default): ');
  const cwdInput = await context.ports.input('Launch cwd (blank for current): ');
  const plan = await context.services.buildLaunchPlan({
    appHomePath: context.appHomePath,
    profileName: optionalInput(profileInput),
    cwd: optionalInput(cwdInput),
  });

  context.ports.writeOut(context.services.formatLaunchDryRun(plan));
}

function writeProfileDetails(ports: TuiPorts, validation: ProfileValidationResult): void {
  ports.writeOut(`Profile: ${validation.profileName}\n`);
  ports.writeOut(`Status: ${validation.status}\n`);
  ports.writeOut(`Profile path: ${validation.profileRootPath}\n`);
  ports.writeOut(`Claude home: ${validation.claudeHomePath}\n`);
  writeFindings(ports, validation);
}

function writeFindings(ports: TuiPorts, validation: ProfileValidationResult): void {
  if (validation.findings.length === 0) {
    ports.writeOut('No findings.\n');
    return;
  }

  ports.writeOut('Findings:\n');
  for (const finding of validation.findings) {
    const pathSuffix = finding.path ? ` (${finding.path})` : '';
    ports.writeOut(`  [${finding.severity}] ${finding.code}: ${finding.message}${pathSuffix}\n`);
  }
}

function optionalInput(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
