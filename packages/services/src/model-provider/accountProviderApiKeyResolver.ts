import {
  ProjectAccessTokenClient,
  type ProjectAccessTokenMaterial,
  resolveBigModelApiOrigin,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { ZAI_API_HOST } from "../providers/api/apiEndpoints.js";
import {
  DEFAULT_ORG_NAME,
  DEFAULT_PROJECT_NAME,
  type AccountApiProviderId,
  type RemoteCustomerInfo,
} from "./accountProviderApiTypes.js";

const log = createServiceLogger("account-project-token-resolver");

export function pickOrgAndProject(customerInfo: RemoteCustomerInfo): {
  organizationId: string;
  projectId: string;
} | null {
  const personalOrganizations = (customerInfo.organizations ?? [])
    .map((organization) => ({
      organization,
      // Team Plan 项目会和个人项目一起返回；个人 Key 只能从非团队项目解析。
      projects: (organization.projects ?? []).filter(
        (project) => String(project.projectType ?? "").trim() !== "2",
      ),
    }))
    .filter(({ organization, projects }) =>
      Boolean(organization.organizationId && projects.length),
    );
  if (personalOrganizations.length === 0) {
    return null;
  }

  const selected =
    personalOrganizations.find(({ organization }) =>
      (organization.organizationName ?? "").includes(DEFAULT_ORG_NAME),
    ) ?? personalOrganizations[0];
  if (!selected?.organization.organizationId) {
    return null;
  }

  const project =
    selected.projects.find((item) => (item.projectName ?? "").includes(DEFAULT_PROJECT_NAME)) ??
    selected.projects[0];
  if (!project?.projectId) {
    return null;
  }

  return {
    organizationId: selected.organization.organizationId,
    projectId: project.projectId,
  };
}

export class AccountProviderApiKeyResolver {
  readonly tokenClient: ProjectAccessTokenClient;
  constructor(
    fetchRemoteData: <T>(url: string, init: RequestInit) => Promise<T | null>,
    tokenClient?: ProjectAccessTokenClient,
  ) {
    this.tokenClient =
      tokenClient ??
      new ProjectAccessTokenClient({
        request: async (url, init) => ({
          code: 200,
          data: await fetchRemoteData(url, init),
        }),
        observe: (event) => log.warn(undefined, "项目 Token 获取失败", event),
      });
  }

  async resolveProviderApiKey(
    ...args: Parameters<AccountProviderApiKeyResolver["resolveProviderMaterial"]>
  ): Promise<string> {
    return (await this.resolveProviderMaterial(...args)).token;
  }

  async resolveProviderMaterial(
    provider: AccountApiProviderId,
    accessToken: string,
    accountIdentity: string = provider,
    rejectedProjectTokenFingerprint?: string,
  ): Promise<ProjectAccessTokenMaterial> {
    const family = provider === ZAI_PROVIDER_ID ? "zai" : "bigmodel";
    const result = await this.tokenClient.resolve({
      origin: family === "zai" ? ZAI_API_HOST : resolveBigModelApiOrigin(process.env),
      family,
      loginToken: accessToken,
      accountId: accountIdentity,
      rejectedProjectTokenFingerprint,
    });
    return result;
  }
}
