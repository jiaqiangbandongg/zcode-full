import type { ISettingService } from "@zcode/services";
import type {
  AppSettings,
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelection,
} from "@zcode/shared";

/** 设置页与 Composer 共用：先提交身份，再由既有 Provider 同步发布可执行目录。 */
export async function persistProviderFamilyConnection<T>({
  family,
  selection,
  read,
  update,
  synchronize,
}: {
  family: ProviderFamilyDomain;
  selection: ProviderFamilyConnectionSelection;
  read: () => Promise<Partial<AppSettings>>;
  update: ISettingService["update"];
  synchronize: (restoring?: boolean) => Promise<T>;
}): Promise<T> {
  const before = { ...(await read()) };
  const updatedAt = Math.max(Date.now(), (before.providerFamilyDomainUpdatedAt ?? 0) + 1);
  // 原因：跨窗口读取的完整映射会过期；提交必须由设置 owner 在写锁内比较，冲突交给用户重试。
  await update(
    {
      providerFamilyDomain: family,
      providerFamilyDomainUpdatedAt: updatedAt,
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: {
        ...before.providerFamilyConnectionSelections,
        [family]: selection,
      },
    },
    {
      providerFamilyDomain: before.providerFamilyDomain,
      providerFamilyConnectionSelections: before.providerFamilyConnectionSelections,
      providerFamilyDomainUpdatedAt: before.providerFamilyDomainUpdatedAt ?? 0,
    },
  );
  try {
    return await synchronize();
  } catch (cause) {
    // 原因：设置已保存而同步失败时，旧模型可能使用新团队身份；恢复设置后重新同步，不能只回退勾选。
    try {
      const latest = await read();
      // 原因：连接按品牌保存，全局品牌却跨窗口共享；仅比连接值会回滚另一品牌的新选择。
      if (
        latest.providerFamilyDomain === family &&
        latest.providerFamilyDomainUpdatedAt === updatedAt &&
        JSON.stringify(latest.providerFamilyConnectionSelections?.[family]) ===
          JSON.stringify(selection)
      ) {
        // 原因：上面的归属检查与写入之间仍可能有并发操作；回滚也必须在锁内 CAS。
        await update(
          {
            providerFamilyDomain: before.providerFamilyDomain,
            providerFamilyDomainUpdatedAt: Date.now(),
            providerFamilyConnectionSelections: {
              ...latest.providerFamilyConnectionSelections,
              [family]: before.providerFamilyConnectionSelections?.[family],
            },
          },
          {
            providerFamilyDomain: latest.providerFamilyDomain,
            providerFamilyConnectionSelections: latest.providerFamilyConnectionSelections,
            providerFamilyDomainUpdatedAt: latest.providerFamilyDomainUpdatedAt ?? 0,
          },
        );
        await synchronize(true);
      }
    } catch (rollbackError) {
      // CAS 冲突说明其他操作已成功；保留新设置，报告原同步失败，不重新发布恢复目录。
      if (
        rollbackError instanceof Error &&
        rollbackError.message === "Account connection settings changed"
      )
        throw cause;
      throw new AggregateError(
        [cause, rollbackError],
        "Connection synchronization and restoration failed",
      );
    }
    throw cause;
  }
}
