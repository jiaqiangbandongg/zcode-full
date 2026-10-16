using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const string Protocol = "ZCODE_BROWSER_IMPORT_V1";
    private const string HelperVersion = "2";
    private const int PipeTimeoutMs = 60000;
    private const int BrokerLifetimeMs = 90000;
    private const int ControllerLifetimeMs = 75000;
    private const int MaxProtocolLineLength = 1024 * 1024;
    private const string ChromeCngProvider = "Microsoft Software Key Storage Provider";
    private const string ChromeCngKey = "Google Chromekey1";

    private static readonly byte[] Flag1Key = Hex(
        "B31C6E241AC846728DA9C1FAC4936651CFFB944D143AB816276BCC6DA0284787");
    private static readonly byte[] Flag2Key = Hex(
        "E98F37D7F4E1FA433D19304DC2258042090E2D1D7EEA7670D41F738D08729660");
    private static readonly byte[] Flag3Mask = Hex(
        "CCF8A1CEC56605B8517552BA1A2D061C03A29E90274FB2FCF59BA4B75C392390");

    private static Dictionary<string, string> serviceArguments;
    private static ServiceMainDelegate serviceMainDelegate;
    private static ServiceControlHandlerDelegate serviceControlHandlerDelegate;
    private static IntPtr serviceStatusHandle;
    private static readonly ManualResetEvent serviceStopEvent = new ManualResetEvent(false);
    private static NamedPipeServerStream activeServicePipe;

    private static int Main(string[] args)
    {
        try
        {
            if (HasArgument(args, "--version"))
            {
                string[] buildIdentity = GetBuildIdentity();
                Console.Out.WriteLine(
                    "ZCODE_BROWSER_IMPORT_HELPER\t" + HelperVersion + "\t" + GetProcessArchitecture() +
                    "\t" + buildIdentity[0] + "\t" + buildIdentity[1]);
                return 0;
            }

            if (HasArgument(args, "--broker"))
            {
                RunBroker(ParseArguments(args));
                return 0;
            }

            if (HasArgument(args, "--elevated"))
            {
                RunElevated(ParseArguments(args));
                return 0;
            }

            if (HasArgument(args, "--service"))
            {
                serviceArguments = ParseArguments(args);
                RunServiceDispatcher();
                return 0;
            }

            return 2;
        }
        catch
        {
            // 安全边界：异常只转换为稳定错误码，绝不把密钥、路径或系统异常文本写入输出。
            if (!HasArgument(args, "--service"))
            {
                WriteError("helper_failed");
            }
            return 1;
        }
    }

    private static void RunBroker(Dictionary<string, string> args)
    {
        int hostPid = ParsePositiveInt(RequireArgument(args, "--parent-pid"));
        using (ManualResetEvent completed = new ManualResetEvent(false))
        {
            Thread watchdog = new Thread(() => MonitorHostAndDeadline(hostPid, completed));
            watchdog.IsBackground = true;
            watchdog.Start();
            try { RunBrokerCore(); }
            finally
            {
                completed.Set();
                watchdog.Join(1000);
            }
        }
    }

    private static void RunBrokerCore()
    {
        string request;
        string pipeName;
        string token;
        NamedPipeServerStream pipe;
        try
        {
            request = ReadBoundedLine(Console.In);
            ValidateImportRequest(request);
            pipeName = "zcode-browser-import-broker-" + Guid.NewGuid().ToString("N");
            token = CreateToken();
            pipe = CreatePipeServer(pipeName, true);
        }
        catch
        {
            // Bugfix 原因：broker 初始化异常原先统一落到 helper_failed，无法区分输入/控制管道尚未建立的失败阶段。
            WriteError("broker_initialization_failed");
            return;
        }

        // 凭据切换式 UAC 会以另一个管理员 SID 启动 elevated controller；控制管道允许管理员，
        // broker 侧用启动后拿到的精确 PID 和随机 token 绑定本次实例，controller 再反向校验 broker 映像路径。
        using (pipe)
        {
            Process elevated;
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo
                {
                    FileName = GetSelfPath(),
                    Arguments = "--elevated --pipe " + pipeName + " --token " + token +
                        " --parent-pid " + Process.GetCurrentProcess().Id,
                    UseShellExecute = true,
                    Verb = "runas",
                    WindowStyle = ProcessWindowStyle.Hidden,
                };
                elevated = Process.Start(startInfo);
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                if (error.NativeErrorCode == 1223)
                {
                    WriteError("elevation_cancelled");
                    return;
                }
                WriteError("elevation_failed");
                return;
            }

            if (elevated == null)
            {
                WriteError("elevation_failed");
                return;
            }

            using (elevated)
            {
                try
                {
                    if (!WaitForConnection(pipe, PipeTimeoutMs))
                    {
                        TryTerminate(elevated);
                        WriteError("timeout");
                        return;
                    }
                    // Bugfix 原因：标准用户通过 UAC 切换到其他管理员账号后，普通 broker 无权跨账号读取
                    // 高完整性 controller 的映像路径；这里仍用 Process.Start 返回的精确 PID、管理员限定
                    // pipe ACL 和一次性 token 绑定连接。controller 反向校验 broker 路径、SYSTEM 服务校验
                    // broker 路径的安全边界保持不变。
                    if (!VerifyPipeClient(pipe.SafePipeHandle, GetSelfPath(), elevated.Id, false))
                    {
                        TryTerminate(elevated);
                        WriteError("peer_verification_failed");
                        return;
                    }
                }
                catch
                {
                    TryTerminate(elevated);
                    // Bugfix 原因：提权控制器在握手阶段断开时，最外层异常只会返回 helper_failed，丢失了失败阶段。
                    WriteError("controller_handshake_failed");
                    return;
                }

                try
                {
                    using (StreamReader reader = CreateReader(pipe))
                    using (StreamWriter writer = CreateWriter(pipe))
                    {
                        if (!FixedTimeEquals(ReadBoundedLine(reader), token))
                        {
                            WriteError("peer_verification_failed");
                            return;
                        }
                        string ready = ReadBoundedLine(reader);
                        string[] readyFields = ready.Split('\t');
                        if (readyFields.Length == 3 && readyFields[0] == Protocol && readyFields[1] == "ERR")
                        {
                            Console.Out.WriteLine(ready);
                            return;
                        }
                        if (readyFields.Length != 5 || readyFields[0] != Protocol || readyFields[1] != "READY")
                        {
                            WriteError("service_failed");
                            return;
                        }

                        string systemPipeName = readyFields[2];
                        string serviceToken = readyFields[3];
                        int servicePid = ParsePositiveInt(readyFields[4]);
                        string response;
                        try
                        {
                            // 用户层 DPAPI 必须 impersonate 原始 broker，而不是 UAC 中可能另输的管理员账号。
                            // 因此普通用户 broker 直接连接 SYSTEM service；elevated controller 只管理服务生命周期。
                            using (NamedPipeClientStream servicePipe = ConnectPipeClient(systemPipeName, servicePid, false))
                            using (StreamReader serviceReader = CreateReader(servicePipe))
                            using (StreamWriter serviceWriter = CreateWriter(servicePipe))
                            {
                                serviceWriter.WriteLine(serviceToken);
                                serviceWriter.WriteLine(request);
                                response = ReadBoundedLine(serviceReader);
                            }
                        }
                        catch
                        {
                            // Bugfix 原因：SYSTEM 服务管道连接或读取中断时不再退化成无阶段信息的 helper_failed。
                            WriteError("service_channel_failed");
                            return;
                        }

                        writer.WriteLine(Protocol + "\tDONE");
                        string cleanup = ReadBoundedLine(reader);
                        if (cleanup != Protocol + "\tCLEANED")
                        {
                            WriteError("service_cleanup_failed");
                            return;
                        }
                        Console.Out.WriteLine(response);
                    }
                }
                catch
                {
                    WriteError("controller_handshake_failed");
                    return;
                }
                try { elevated.WaitForExit(5000); }
                catch { }
            }
        }
    }

    private static void RunElevated(Dictionary<string, string> args)
    {
        if (!IsAdministrator())
        {
            return;
        }

        string brokerPipeName = RequireArgument(args, "--pipe");
        string brokerToken = RequireArgument(args, "--token");
        int parentPid = ParsePositiveInt(RequireArgument(args, "--parent-pid"));

        using (NamedPipeClientStream brokerPipe = ConnectPipeClient(brokerPipeName, parentPid))
        using (ManualResetEvent completed = new ManualResetEvent(false))
        {
            Thread watchdog = new Thread(
                () => MonitorBrokerAndDeadline(brokerPipe, parentPid, completed));
            watchdog.IsBackground = true;
            watchdog.Start();
            try
            {
                using (StreamReader brokerReader = CreateReader(brokerPipe))
                using (StreamWriter brokerWriter = CreateWriter(brokerPipe))
                {
                    brokerWriter.WriteLine(brokerToken);
                    RunTemporarySystemService(brokerReader, brokerWriter, parentPid);
                }
            }
            finally
            {
                completed.Set();
                watchdog.Join(1000);
            }
        }
    }

    private static void MonitorHostAndDeadline(int hostPid, ManualResetEvent completed)
    {
        IntPtr hostProcess = OpenProcess(ProcessSynchronize, false, hostPid);
        if (hostProcess == IntPtr.Zero) Environment.Exit(1);
        try
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(BrokerLifetimeMs);
            while (!completed.WaitOne(100))
            {
                uint wait = WaitForSingleObject(hostProcess, 0);
                if (wait == WaitObject0 || wait == WaitFailed || DateTime.UtcNow >= deadline)
                    Environment.Exit(1);
            }
        }
        finally { CloseHandle(hostProcess); }
    }

    private static void MonitorBrokerAndDeadline(
        NamedPipeClientStream brokerPipe,
        int parentPid,
        ManualResetEvent completed)
    {
        IntPtr brokerProcess = OpenProcess(
            ProcessSynchronize | ProcessQueryLimitedInformation,
            false,
            parentPid);
        try
        {
            if (brokerProcess == IntPtr.Zero ||
                !VerifyProcessImagePathHandle(brokerProcess, GetSelfPath()))
            {
                brokerPipe.Dispose();
                return;
            }
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(ControllerLifetimeMs);
            while (!completed.WaitOne(100))
            {
                uint wait = WaitForSingleObject(brokerProcess, 0);
                if (wait == WaitObject0 || wait == WaitFailed || DateTime.UtcNow >= deadline)
                {
                    // Bugfix 原因：Electron 退出后 broker 可能仍卡在 SYSTEM 服务响应，不能再依赖 JS 定时器。
                    // controller 自己关闭控制管道，强制 RunTemporarySystemService 进入 finally 停止/删除服务。
                    brokerPipe.Dispose();
                    return;
                }
            }
        }
        finally
        {
            if (brokerProcess != IntPtr.Zero) CloseHandle(brokerProcess);
        }
    }

    private static void RunTemporarySystemService(
        StreamReader brokerReader,
        StreamWriter brokerWriter,
        int brokerPid)
    {
        string serviceName = "ZCodeBrowserImport_" + Guid.NewGuid().ToString("N");
        string pipeName = "zcode-browser-import-system-" + Guid.NewGuid().ToString("N");
        string token = CreateToken();
        IntPtr scm = IntPtr.Zero;
        IntPtr service = IntPtr.Zero;
        bool serviceStarted = false;
        bool cleanupSucceeded = false;

        try
        {
            scm = OpenSCManager(null, null, ScManagerCreateService);
            if (scm == IntPtr.Zero) throw new InvalidOperationException();

            string commandLine = QuoteCommandLineArgument(GetSelfPath()) +
                " --service --pipe " + pipeName + " --token " + token +
                " --broker-pid " + brokerPid +
                " --service-name " + serviceName;
            service = CreateService(
                scm,
                serviceName,
                serviceName,
                ServiceAllAccess,
                ServiceWin32OwnProcess,
                ServiceDemandStart,
                ServiceErrorNormal,
                commandLine,
                null,
                IntPtr.Zero,
                null,
                null,
                null);
            if (service == IntPtr.Zero) throw new InvalidOperationException();
            if (!StartService(service, 0, null)) throw new InvalidOperationException();
            serviceStarted = true;
            int servicePid = WaitForServiceProcessId(service, PipeTimeoutMs);
            if (servicePid <= 0) throw new InvalidOperationException();

            brokerWriter.WriteLine(
                Protocol + "\tREADY\t" + pipeName + "\t" + token + "\t" + servicePid);
            if (ReadBoundedLine(brokerReader) != Protocol + "\tDONE")
                throw new InvalidDataException();
        }
        catch
        {
            if (!serviceStarted) brokerWriter.WriteLine(ErrorResponse("service_failed"));
        }
        finally
        {
            // Bugfix 原因：临时 LocalSystem 服务若只在成功路径删除，UAC 后的超时/管道异常会留下高权限常驻项。
            // 所有退出路径都先请求停止；无响应时只终止 SCM 返回且映像路径匹配的精确服务 PID，再删除并核验。
            cleanupSucceeded = CleanupTemporaryService(scm, service, serviceName);
        }

        if (serviceStarted)
        {
            brokerWriter.WriteLine(
                cleanupSucceeded ? Protocol + "\tCLEANED" : ErrorResponse("service_cleanup_failed"));
        }
    }

    private static int WaitForServiceProcessId(IntPtr service, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        do
        {
            ServiceStatusProcess status;
            if (TryQueryServiceStatus(service, out status))
            {
                if (status.currentState == ServiceStopped) return -1;
                if (status.processId > 0) return status.processId;
            }
            Thread.Sleep(50);
        }
        while (DateTime.UtcNow < deadline);
        return -1;
    }

    private static bool CleanupTemporaryService(
        IntPtr scm,
        IntPtr service,
        string serviceName)
    {
        bool stopped = service == IntPtr.Zero;
        bool deleted = service == IntPtr.Zero;
        try
        {
            if (service != IntPtr.Zero)
            {
                ServiceStatus ignored = new ServiceStatus();
                if (!ControlService(service, ServiceControlStop, ref ignored))
                {
                    int stopError = Marshal.GetLastWin32Error();
                    if (stopError == ErrorServiceNotActive) stopped = true;
                }
                if (!stopped) stopped = WaitForServiceStopped(service, 5000);
                if (!stopped)
                {
                    ServiceStatusProcess status;
                    if (TryQueryServiceStatus(service, out status) && status.processId > 0)
                        stopped = TerminateVerifiedServiceProcess(status.processId);
                }

                deleted = DeleteService(service);
                if (!deleted)
                {
                    int deleteError = Marshal.GetLastWin32Error();
                    deleted = deleteError == ErrorServiceMarkedForDelete ||
                        deleteError == ErrorServiceDoesNotExist;
                }
            }
        }
        finally
        {
            if (service != IntPtr.Zero) CloseServiceHandle(service);
            if (scm != IntPtr.Zero) CloseServiceHandle(scm);
        }
        return stopped && deleted && WaitForServiceAbsent(serviceName, 5000);
    }

    private static bool WaitForServiceStopped(IntPtr service, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        do
        {
            ServiceStatusProcess status;
            if (!TryQueryServiceStatus(service, out status)) return false;
            if (status.currentState == ServiceStopped) return true;
            Thread.Sleep(50);
        }
        while (DateTime.UtcNow < deadline);
        return false;
    }

    private static bool TryQueryServiceStatus(IntPtr service, out ServiceStatusProcess status)
    {
        status = new ServiceStatusProcess();
        int bytesNeeded;
        return QueryServiceStatusEx(
            service,
            ServiceStatusProcessInfo,
            ref status,
            Marshal.SizeOf(typeof(ServiceStatusProcess)),
            out bytesNeeded);
    }

    private static bool TerminateVerifiedServiceProcess(int processId)
    {
        IntPtr serviceProcess = OpenProcess(
            ProcessTerminate | ProcessSynchronize | ProcessQueryLimitedInformation,
            false,
            processId);
        if (serviceProcess == IntPtr.Zero) return false;
        try
        {
            return VerifyProcessImagePathHandle(serviceProcess, GetSelfPath()) &&
                TerminateProcess(serviceProcess, 1) &&
                WaitForSingleObject(serviceProcess, 5000) == WaitObject0;
        }
        finally { CloseHandle(serviceProcess); }
    }

    private static bool WaitForServiceAbsent(string serviceName, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        do
        {
            IntPtr manager = OpenSCManager(null, null, ScManagerConnect);
            if (manager == IntPtr.Zero) return false;
            IntPtr candidate = IntPtr.Zero;
            try
            {
                candidate = OpenService(manager, serviceName, ServiceQueryStatus);
                if (candidate == IntPtr.Zero)
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ErrorServiceDoesNotExist || error == ErrorServiceMarkedForDelete)
                        return true;
                }
            }
            finally
            {
                if (candidate != IntPtr.Zero) CloseServiceHandle(candidate);
                CloseServiceHandle(manager);
            }
            Thread.Sleep(50);
        }
        while (DateTime.UtcNow < deadline);
        return false;
    }

    private static void RunServiceDispatcher()
    {
        serviceMainDelegate = ServiceMain;
        ServiceTableEntry[] table = new ServiceTableEntry[2];
        table[0] = new ServiceTableEntry
        {
            serviceName = RequireArgument(serviceArguments, "--service-name"),
            serviceMain = serviceMainDelegate,
        };
        table[1] = new ServiceTableEntry();
        if (!StartServiceCtrlDispatcher(table)) throw new InvalidOperationException();
    }

    private static void ServiceMain(int argc, IntPtr argv)
    {
        serviceControlHandlerDelegate = ServiceControlHandler;
        serviceStatusHandle = RegisterServiceCtrlHandler(
            RequireArgument(serviceArguments, "--service-name"), serviceControlHandlerDelegate);
        SetCurrentServiceStatus(ServiceRunning, Win32OwnProcessAccepted);
        try
        {
            RunServiceWorker(serviceArguments);
        }
        catch
        {
            // 服务异常只影响本次导入；最终状态和自删除仍必须执行。
        }
        finally
        {
            TryDeleteCurrentService(RequireArgument(serviceArguments, "--service-name"));
            SetCurrentServiceStatus(ServiceStopped, 0);
        }
    }

    private static void TryDeleteCurrentService(string serviceName)
    {
        IntPtr manager = IntPtr.Zero;
        IntPtr service = IntPtr.Zero;
        try
        {
            manager = OpenSCManager(null, null, ScManagerConnect);
            if (manager == IntPtr.Zero) return;
            service = OpenService(manager, serviceName, DeleteAccess);
            if (service != IntPtr.Zero) DeleteService(service);
        }
        catch { }
        finally
        {
            if (service != IntPtr.Zero) CloseServiceHandle(service);
            if (manager != IntPtr.Zero) CloseServiceHandle(manager);
        }
    }

    private static void RunServiceWorker(Dictionary<string, string> args)
    {
        if (!IsLocalSystem()) return;
        string pipeName = RequireArgument(args, "--pipe");
        string token = RequireArgument(args, "--token");
        int brokerPid = ParsePositiveInt(RequireArgument(serviceArguments, "--broker-pid"));

        // SYSTEM 服务只向原始普通用户 broker 暴露一次性 pipe；精确 PID/映像路径/token 仍是授权依据。
        using (NamedPipeServerStream pipe = CreatePipeServer(pipeName, false, true))
        {
            activeServicePipe = pipe;
            try
            {
                if (!WaitForConnection(pipe, PipeTimeoutMs) ||
                    !VerifyPipeClient(pipe.SafePipeHandle, GetSelfPath(), brokerPid))
                {
                    return;
                }
                using (StreamReader reader = CreateReader(pipe))
                using (StreamWriter writer = CreateWriter(pipe))
                {
                    if (!FixedTimeEquals(ReadBoundedLine(reader), token)) return;
                    string request = ReadBoundedLine(reader);
                    byte[] masterKey = null;
                    ImportRequest parsed = null;
                    try
                    {
                        parsed = ParseImportRequest(request);
                        masterKey = DecryptAppBoundKey(pipe.SafePipeHandle, parsed.EncryptedKey, parsed.ChromeExecutablePath);
                        writer.WriteLine(Protocol + "\tOK\t" + Convert.ToBase64String(masterKey));
                    }
                    catch (ChromeValidationException)
                    {
                        writer.WriteLine(ErrorResponse("validation_failed"));
                    }
                    catch (UnsupportedKeyException)
                    {
                        writer.WriteLine(ErrorResponse("unsupported_key"));
                    }
                    catch (CngException)
                    {
                        writer.WriteLine(ErrorResponse("cng_failed"));
                    }
                    catch
                    {
                        writer.WriteLine(ErrorResponse("decryption_failed"));
                    }
                    finally
                    {
                        if (parsed != null) Zero(parsed.EncryptedKey);
                        Zero(masterKey);
                    }
                }
            }
            finally { activeServicePipe = null; }
        }
    }

    private static byte[] DecryptAppBoundKey(SafePipeHandle pipeHandle, byte[] encryptedKey, string chromeExecutablePath)
    {
        byte[] systemPlaintext = null;
        byte[] userPlaintext = null;
        byte[] content = null;
        try
        {
            systemPlaintext = DpapiUnprotect(encryptedKey);
            if (!ImpersonateNamedPipeClient(pipeHandle.DangerousGetHandle()))
                throw new InvalidOperationException();
            try
            {
                userPlaintext = DpapiUnprotect(systemPlaintext);
            }
            finally
            {
                RevertToSelf();
            }

            ParsedAppBoundBlob parsed = ParseAppBoundBlob(userPlaintext);
            try
            {
                content = parsed.Content;
                ValidateChromePath(parsed.ValidationData, chromeExecutablePath);
                return DeriveChromeMasterKey(content);
            }
            finally
            {
                Zero(parsed.ValidationData);
            }
        }
        finally
        {
            Zero(systemPlaintext);
            Zero(userPlaintext);
            Zero(content);
        }
    }

    private static ParsedAppBoundBlob ParseAppBoundBlob(byte[] data)
    {
        if (data == null || data.Length < 10) throw new InvalidDataException();
        int offset = 0;
        uint validationLength = ReadUInt32(data, ref offset);
        if (validationLength == 0 || validationLength > data.Length - offset - 4)
            throw new InvalidDataException();
        byte[] validation = CopyRange(data, ref offset, checked((int)validationLength));
        uint contentLength = ReadUInt32(data, ref offset);
        if (contentLength == 0 || contentLength != data.Length - offset)
            throw new InvalidDataException();
        byte[] content = CopyRange(data, ref offset, checked((int)contentLength));
        return new ParsedAppBoundBlob(validation, content);
    }

    private static void ValidateChromePath(byte[] validationData, string chromeExecutablePath)
    {
        if (validationData == null || validationData.Length < 2) throw new ChromeValidationException();
        int pathOffset;
        if (validationData[0] == 2) pathOffset = 1;
        else if (validationData[0] == 3 && validationData.Length >= 3) pathOffset = 2;
        else throw new ChromeValidationException();

        string protectedPath = Encoding.UTF8.GetString(
            validationData, pathOffset, validationData.Length - pathOffset);
        string expectedPath = TrimChromeValidationPath(chromeExecutablePath);
        string actualPath = NormalizeProgramFilesPath(protectedPath);
        if (!string.Equals(expectedPath, actualPath, StringComparison.OrdinalIgnoreCase))
            throw new ChromeValidationException();
    }

    private static string TrimChromeValidationPath(string executablePath)
    {
        string path = Path.GetFullPath(executablePath).TrimEnd(Path.DirectorySeparatorChar);
        path = Path.GetDirectoryName(path);
        while (!string.IsNullOrEmpty(path))
        {
            string name = Path.GetFileName(path);
            Version version;
            if (string.Equals(name, "Application", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(name, "Temp", StringComparison.OrdinalIgnoreCase) ||
                Version.TryParse(name, out version))
            {
                path = Path.GetDirectoryName(path);
                continue;
            }
            break;
        }
        return NormalizeProgramFilesPath(path);
    }

    private static string NormalizeProgramFilesPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ChromeValidationException();
        string normalized = Path.GetFullPath(path.Trim()).TrimEnd(Path.DirectorySeparatorChar);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrEmpty(programFilesX86) && !string.IsNullOrEmpty(programFiles) &&
            normalized.StartsWith(programFilesX86 + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            normalized = programFiles + normalized.Substring(programFilesX86.Length);
        }
        return normalized;
    }

    private static byte[] DeriveChromeMasterKey(byte[] content)
    {
        if (content == null || content.Length < 1) throw new UnsupportedKeyException();
        byte flag = content[0];
        if ((flag == 1 || flag == 2) && content.Length == 61)
        {
            byte[] nonce = Slice(content, 1, 12);
            byte[] ciphertext = Slice(content, 13, 32);
            byte[] tag = Slice(content, 45, 16);
            try
            {
                return flag == 1
                    ? AesGcmDecrypt(Flag1Key, nonce, ciphertext, tag)
                    : ChaCha20Poly1305Decrypt(Flag2Key, nonce, ciphertext, tag);
            }
            finally
            {
                Zero(nonce);
                Zero(ciphertext);
                Zero(tag);
            }
        }

        if (flag == 3 && content.Length == 93)
        {
            byte[] encryptedAesKey = Slice(content, 1, 32);
            byte[] nonce = Slice(content, 33, 12);
            byte[] ciphertext = Slice(content, 45, 32);
            byte[] tag = Slice(content, 77, 16);
            byte[] aesKey = null;
            try
            {
                aesKey = DecryptChromeCngKey(encryptedAesKey);
                if (aesKey.Length != 32) throw new CngException();
                for (int i = 0; i < aesKey.Length; i++) aesKey[i] ^= Flag3Mask[i];
                return AesGcmDecrypt(aesKey, nonce, ciphertext, tag);
            }
            finally
            {
                Zero(encryptedAesKey);
                Zero(nonce);
                Zero(ciphertext);
                Zero(tag);
                Zero(aesKey);
            }
        }
        throw new UnsupportedKeyException();
    }

    private static byte[] DecryptChromeCngKey(byte[] encrypted)
    {
        IntPtr provider = IntPtr.Zero;
        IntPtr key = IntPtr.Zero;
        try
        {
            if (NCryptOpenStorageProvider(out provider, ChromeCngProvider, 0) != 0)
                throw new CngException();
            if (NCryptOpenKey(provider, out key, ChromeCngKey, 0, 0) != 0)
                throw new CngException();
            int outputLength;
            if (NCryptDecrypt(key, encrypted, encrypted.Length, IntPtr.Zero, null, 0, out outputLength, NCryptSilentFlag) != 0 ||
                outputLength <= 0 || outputLength > 1024)
                throw new CngException();
            byte[] output = new byte[outputLength];
            int written;
            if (NCryptDecrypt(key, encrypted, encrypted.Length, IntPtr.Zero, output, output.Length, out written, NCryptSilentFlag) != 0 ||
                written != output.Length)
            {
                Zero(output);
                throw new CngException();
            }
            return output;
        }
        finally
        {
            if (key != IntPtr.Zero) NCryptFreeObject(key);
            if (provider != IntPtr.Zero) NCryptFreeObject(provider);
        }
    }

    private static byte[] AesGcmDecrypt(byte[] key, byte[] nonce, byte[] ciphertext, byte[] tag)
    {
        IntPtr algorithm = IntPtr.Zero;
        IntPtr keyHandle = IntPtr.Zero;
        GCHandle nonceHandle = default(GCHandle);
        GCHandle tagHandle = default(GCHandle);
        try
        {
            CheckNtStatus(BCryptOpenAlgorithmProvider(out algorithm, "AES", null, 0));
            byte[] mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            CheckNtStatus(BCryptSetProperty(algorithm, "ChainingMode", mode, mode.Length, 0));
            int objectLength = GetBcryptIntProperty(algorithm, "ObjectLength");
            byte[] keyObject = new byte[objectLength];
            try
            {
                CheckNtStatus(BCryptGenerateSymmetricKey(
                    algorithm, out keyHandle, keyObject, keyObject.Length, key, key.Length, 0));
                nonceHandle = GCHandle.Alloc(nonce, GCHandleType.Pinned);
                tagHandle = GCHandle.Alloc(tag, GCHandleType.Pinned);
                BcryptAuthenticatedCipherModeInfo authInfo = new BcryptAuthenticatedCipherModeInfo
                {
                    cbSize = Marshal.SizeOf(typeof(BcryptAuthenticatedCipherModeInfo)),
                    dwInfoVersion = 1,
                    pbNonce = nonceHandle.AddrOfPinnedObject(),
                    cbNonce = nonce.Length,
                    pbTag = tagHandle.AddrOfPinnedObject(),
                    cbTag = tag.Length,
                };
                byte[] plaintext = new byte[ciphertext.Length];
                int written;
                int status = BCryptDecrypt(
                    keyHandle, ciphertext, ciphertext.Length, ref authInfo,
                    null, 0, plaintext, plaintext.Length, out written, 0);
                if (status != 0 || written != plaintext.Length)
                {
                    Zero(plaintext);
                    CheckNtStatus(status);
                    throw new CryptographicException();
                }
                return plaintext;
            }
            finally
            {
                Zero(keyObject);
            }
        }
        finally
        {
            if (tagHandle.IsAllocated) tagHandle.Free();
            if (nonceHandle.IsAllocated) nonceHandle.Free();
            if (keyHandle != IntPtr.Zero) BCryptDestroyKey(keyHandle);
            if (algorithm != IntPtr.Zero) BCryptCloseAlgorithmProvider(algorithm, 0);
        }
    }

    private static byte[] ChaCha20Poly1305Decrypt(byte[] key, byte[] nonce, byte[] ciphertext, byte[] expectedTag)
    {
        byte[] firstBlock = ChaCha20Block(key, nonce, 0);
        byte[] oneTimeKey = Slice(firstBlock, 0, 32);
        byte[] macInput = BuildPoly1305Input(ciphertext);
        byte[] actualTag = null;
        try
        {
            actualTag = Poly1305(oneTimeKey, macInput);
            if (!FixedTimeEquals(actualTag, expectedTag)) throw new CryptographicException();
            byte[] plaintext = new byte[ciphertext.Length];
            int offset = 0;
            uint counter = 1;
            while (offset < ciphertext.Length)
            {
                byte[] block = ChaCha20Block(key, nonce, counter++);
                try
                {
                    int take = Math.Min(64, ciphertext.Length - offset);
                    for (int i = 0; i < take; i++) plaintext[offset + i] = (byte)(ciphertext[offset + i] ^ block[i]);
                    offset += take;
                }
                finally { Zero(block); }
            }
            return plaintext;
        }
        finally
        {
            Zero(firstBlock);
            Zero(oneTimeKey);
            Zero(macInput);
            Zero(actualTag);
        }
    }

    private static byte[] ChaCha20Block(byte[] key, byte[] nonce, uint counter)
    {
        if (key.Length != 32 || nonce.Length != 12) throw new CryptographicException();
        uint[] state = new uint[16]
        {
            0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
            ReadUInt32(key, 0), ReadUInt32(key, 4), ReadUInt32(key, 8), ReadUInt32(key, 12),
            ReadUInt32(key, 16), ReadUInt32(key, 20), ReadUInt32(key, 24), ReadUInt32(key, 28),
            counter, ReadUInt32(nonce, 0), ReadUInt32(nonce, 4), ReadUInt32(nonce, 8),
        };
        uint[] working = (uint[])state.Clone();
        for (int i = 0; i < 10; i++)
        {
            QuarterRound(working, 0, 4, 8, 12); QuarterRound(working, 1, 5, 9, 13);
            QuarterRound(working, 2, 6, 10, 14); QuarterRound(working, 3, 7, 11, 15);
            QuarterRound(working, 0, 5, 10, 15); QuarterRound(working, 1, 6, 11, 12);
            QuarterRound(working, 2, 7, 8, 13); QuarterRound(working, 3, 4, 9, 14);
        }
        byte[] output = new byte[64];
        for (int i = 0; i < 16; i++) WriteUInt32(output, i * 4, unchecked(working[i] + state[i]));
        Array.Clear(state, 0, state.Length);
        Array.Clear(working, 0, working.Length);
        return output;
    }

    private static void QuarterRound(uint[] x, int a, int b, int c, int d)
    {
        x[a] = unchecked(x[a] + x[b]); x[d] = RotateLeft(x[d] ^ x[a], 16);
        x[c] = unchecked(x[c] + x[d]); x[b] = RotateLeft(x[b] ^ x[c], 12);
        x[a] = unchecked(x[a] + x[b]); x[d] = RotateLeft(x[d] ^ x[a], 8);
        x[c] = unchecked(x[c] + x[d]); x[b] = RotateLeft(x[b] ^ x[c], 7);
    }

    private static byte[] BuildPoly1305Input(byte[] ciphertext)
    {
        int paddedCiphertext = (ciphertext.Length + 15) & ~15;
        byte[] input = new byte[paddedCiphertext + 16];
        Buffer.BlockCopy(ciphertext, 0, input, 0, ciphertext.Length);
        WriteUInt64(input, paddedCiphertext + 8, (ulong)ciphertext.Length);
        return input;
    }

    private static byte[] Poly1305(byte[] key, byte[] data)
    {
        byte[] rBytes = Slice(key, 0, 16);
        rBytes[3] &= 15; rBytes[7] &= 15; rBytes[11] &= 15; rBytes[15] &= 15;
        rBytes[4] &= 252; rBytes[8] &= 252; rBytes[12] &= 252;
        BigInteger r = FromUnsignedLittleEndian(rBytes);
        BigInteger s = FromUnsignedLittleEndian(Slice(key, 16, 16));
        BigInteger p = (BigInteger.One << 130) - 5;
        BigInteger accumulator = BigInteger.Zero;
        for (int offset = 0; offset < data.Length; offset += 16)
        {
            int count = Math.Min(16, data.Length - offset);
            byte[] block = new byte[count + 1];
            Buffer.BlockCopy(data, offset, block, 0, count);
            block[count] = 1;
            accumulator = ((accumulator + FromUnsignedLittleEndian(block)) * r) % p;
            Zero(block);
        }
        BigInteger tagValue = (accumulator + s) & ((BigInteger.One << 128) - 1);
        byte[] encoded = tagValue.ToByteArray();
        byte[] tag = new byte[16];
        Buffer.BlockCopy(encoded, 0, tag, 0, Math.Min(encoded.Length, tag.Length));
        Zero(rBytes);
        Zero(encoded);
        return tag;
    }

    private static BigInteger FromUnsignedLittleEndian(byte[] value)
    {
        byte[] signed = new byte[value.Length + 1];
        Buffer.BlockCopy(value, 0, signed, 0, value.Length);
        BigInteger result = new BigInteger(signed);
        Zero(signed);
        return result;
    }

    private static byte[] DpapiUnprotect(byte[] encrypted)
    {
        GCHandle inputHandle = GCHandle.Alloc(encrypted, GCHandleType.Pinned);
        DataBlob input = new DataBlob { cbData = encrypted.Length, pbData = inputHandle.AddrOfPinnedObject() };
        DataBlob output = new DataBlob();
        try
        {
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref output))
                throw new CryptographicException();
            byte[] plaintext = new byte[output.cbData];
            Marshal.Copy(output.pbData, plaintext, 0, plaintext.Length);
            return plaintext;
        }
        finally
        {
            inputHandle.Free();
            if (output.pbData != IntPtr.Zero)
            {
                RtlSecureZeroMemory(output.pbData, new UIntPtr((uint)Math.Max(0, output.cbData)));
                LocalFree(output.pbData);
            }
        }
    }

    private static NamedPipeServerStream CreatePipeServer(
        string pipeName,
        bool allowAdministrators = false,
        bool allowAuthenticatedUsers = false)
    {
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
        if (currentUser == null) throw new InvalidOperationException();
        security.AddAccessRule(new PipeAccessRule(currentUser, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        if (allowAdministrators)
        {
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                PipeAccessRights.ReadWrite,
                AccessControlType.Allow));
        }
        if (allowAuthenticatedUsers)
        {
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                PipeAccessRights.ReadWrite,
                AccessControlType.Allow));
        }
        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            // Bugfix 原因：WaitForConnection 使用 Begin/End 异步等待实现硬超时；同步管道会在
            // controller/service 接入前直接抛 InvalidOperationException，导致 Cookie 解密从未开始。
            PipeOptions.Asynchronous,
            4096,
            4096,
            security);
    }

    private static NamedPipeClientStream ConnectPipeClient(
        string pipeName,
        int? expectedServerPid,
        bool verifyServerImagePath = true)
    {
        NamedPipeClientStream pipe = new NamedPipeClientStream(
            ".", pipeName, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Impersonation);
        pipe.Connect(PipeTimeoutMs);
        pipe.ReadMode = PipeTransmissionMode.Byte;
        uint serverPid;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverPid) ||
            (expectedServerPid.HasValue && serverPid != expectedServerPid.Value) ||
            (verifyServerImagePath && !VerifyProcessImagePath((int)serverPid, GetSelfPath())))
        {
            pipe.Dispose();
            throw new InvalidOperationException();
        }
        return pipe;
    }

    private static bool WaitForConnection(NamedPipeServerStream pipe, int timeoutMs)
    {
        IAsyncResult wait = pipe.BeginWaitForConnection(null, null);
        if (!wait.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
        pipe.EndWaitForConnection(wait);
        return true;
    }

    private static bool VerifyPipeClient(
        SafePipeHandle pipeHandle,
        string expectedPath,
        int? expectedPid = null,
        bool verifyClientImagePath = true)
    {
        uint clientPid;
        return GetNamedPipeClientProcessId(pipeHandle, out clientPid) &&
            (!expectedPid.HasValue || clientPid == expectedPid.Value) &&
            (!verifyClientImagePath || VerifyProcessImagePath((int)clientPid, expectedPath));
    }

    private static bool VerifyProcessImagePath(int processId, string expectedPath)
    {
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero) return false;
        try
        {
            return VerifyProcessImagePathHandle(process, expectedPath);
        }
        finally { CloseHandle(process); }
    }

    private static bool VerifyProcessImagePathHandle(IntPtr process, string expectedPath)
    {
        StringBuilder path = new StringBuilder(32768);
        int length = path.Capacity;
        return QueryFullProcessImageName(process, 0, path, ref length) &&
            string.Equals(
                Path.GetFullPath(path.ToString()),
                Path.GetFullPath(expectedPath),
                StringComparison.OrdinalIgnoreCase);
    }

    private static StreamReader CreateReader(Stream stream)
    {
        return new StreamReader(stream, new UTF8Encoding(false, true), false, 4096, true);
    }

    private static StreamWriter CreateWriter(Stream stream)
    {
        return new StreamWriter(stream, new UTF8Encoding(false), 4096, true) { AutoFlush = true, NewLine = "\n" };
    }

    private static string ReadBoundedLine(TextReader reader)
    {
        StringBuilder line = new StringBuilder();
        while (line.Length <= MaxProtocolLineLength)
        {
            int value = reader.Read();
            if (value == -1 || value == '\n') break;
            if (value != '\r') line.Append((char)value);
        }
        if (line.Length == 0 || line.Length > MaxProtocolLineLength) throw new InvalidDataException();
        return line.ToString();
    }

    private static void ValidateImportRequest(string request)
    {
        ImportRequest parsed = ParseImportRequest(request);
        Zero(parsed.EncryptedKey);
    }

    private static ImportRequest ParseImportRequest(string request)
    {
        string[] parts = request.Split('\t');
        if (parts.Length != 3 || parts[0] != Protocol) throw new InvalidDataException();
        byte[] encryptedKey = Convert.FromBase64String(parts[1]);
        string chromePath = Encoding.UTF8.GetString(Convert.FromBase64String(parts[2]));
        if (encryptedKey.Length < 32 || encryptedKey.Length > 65536 ||
            string.IsNullOrWhiteSpace(chromePath) || chromePath.Length > 32768 ||
            !string.Equals(Path.GetExtension(chromePath), ".exe", StringComparison.OrdinalIgnoreCase))
        {
            Zero(encryptedKey);
            throw new InvalidDataException();
        }
        return new ImportRequest(encryptedKey, chromePath);
    }

    private static Dictionary<string, string> ParseArguments(string[] args)
    {
        Dictionary<string, string> parsed = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                parsed[args[i]] = args[++i];
            else parsed[args[i]] = string.Empty;
        }
        return parsed;
    }

    private static string RequireArgument(Dictionary<string, string> args, string key)
    {
        string value;
        if (!args.TryGetValue(key, out value) || string.IsNullOrWhiteSpace(value))
            throw new InvalidDataException();
        return value;
    }

    private static int ParsePositiveInt(string value)
    {
        int parsed;
        if (!int.TryParse(value, out parsed) || parsed <= 0) throw new InvalidDataException();
        return parsed;
    }

    private static bool HasArgument(string[] args, string target)
    {
        foreach (string value in args) if (value == target) return true;
        return false;
    }

    private static string GetSelfPath()
    {
        return Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
    }

    private static string CreateToken()
    {
        byte[] token = new byte[32];
        using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(token);
        string encoded = BitConverter.ToString(token).Replace("-", string.Empty);
        Zero(token);
        return encoded;
    }

    private static bool IsAdministrator()
    {
        WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
        return principal.IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static bool IsLocalSystem()
    {
        SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
        return sid != null && sid.IsWellKnown(WellKnownSidType.LocalSystemSid);
    }

    private static void WriteError(string code)
    {
        Console.Out.WriteLine(ErrorResponse(code));
    }

    private static string ErrorResponse(string code)
    {
        return Protocol + "\tERR\t" + code;
    }

    private static string QuoteCommandLineArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        return FixedTimeEquals(Encoding.UTF8.GetBytes(left), Encoding.UTF8.GetBytes(right));
    }

    private static bool FixedTimeEquals(byte[] left, byte[] right)
    {
        int difference = left.Length ^ right.Length;
        int length = Math.Max(left.Length, right.Length);
        for (int i = 0; i < length; i++)
        {
            byte a = i < left.Length ? left[i] : (byte)0;
            byte b = i < right.Length ? right[i] : (byte)0;
            difference |= a ^ b;
        }
        return difference == 0;
    }

    private static void TryTerminate(Process process)
    {
        try { if (!process.HasExited) process.Kill(); } catch { }
    }

    private static byte[] Slice(byte[] value, int offset, int count)
    {
        byte[] result = new byte[count];
        Buffer.BlockCopy(value, offset, result, 0, count);
        return result;
    }

    private static byte[] CopyRange(byte[] value, ref int offset, int count)
    {
        if (count < 0 || offset < 0 || offset > value.Length - count) throw new InvalidDataException();
        byte[] result = Slice(value, offset, count);
        offset += count;
        return result;
    }

    private static uint ReadUInt32(byte[] data, ref int offset)
    {
        if (offset > data.Length - 4) throw new InvalidDataException();
        uint value = ReadUInt32(data, offset);
        offset += 4;
        return value;
    }

    private static uint ReadUInt32(byte[] data, int offset)
    {
        return (uint)(data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24));
    }

    private static void WriteUInt32(byte[] data, int offset, uint value)
    {
        data[offset] = (byte)value; data[offset + 1] = (byte)(value >> 8);
        data[offset + 2] = (byte)(value >> 16); data[offset + 3] = (byte)(value >> 24);
    }

    private static void WriteUInt64(byte[] data, int offset, ulong value)
    {
        for (int i = 0; i < 8; i++) data[offset + i] = (byte)(value >> (i * 8));
    }

    private static uint RotateLeft(uint value, int count)
    {
        return (value << count) | (value >> (32 - count));
    }

    private static byte[] Hex(string value)
    {
        byte[] result = new byte[value.Length / 2];
        for (int i = 0; i < result.Length; i++) result[i] = Convert.ToByte(value.Substring(i * 2, 2), 16);
        return result;
    }

    private static void Zero(byte[] value)
    {
        if (value != null) Array.Clear(value, 0, value.Length);
    }

    private static int GetBcryptIntProperty(IntPtr handle, string property)
    {
        byte[] value = new byte[4];
        int written;
        CheckNtStatus(BCryptGetProperty(handle, property, value, value.Length, out written, 0));
        if (written != 4) throw new CryptographicException();
        return BitConverter.ToInt32(value, 0);
    }

    private static void CheckNtStatus(int status)
    {
        if (status != 0) throw new CryptographicException();
    }

    private static string GetProcessArchitecture()
    {
        ushort processMachine;
        ushort nativeMachine;
        if (IsWow64Process2(Process.GetCurrentProcess().Handle, out processMachine, out nativeMachine))
        {
            ushort machine = processMachine == ImageFileMachineUnknown ? nativeMachine : processMachine;
            if (machine == ImageFileMachineAmd64) return "x64";
            if (machine == ImageFileMachineArm64) return "arm64";
            if (machine == ImageFileMachineI386) return "ia32";
        }
        return Environment.Is64BitProcess ? "x64" : "ia32";
    }

    private static string[] GetBuildIdentity()
    {
        AssemblyInformationalVersionAttribute attribute = (AssemblyInformationalVersionAttribute)
            Attribute.GetCustomAttribute(
                Assembly.GetExecutingAssembly(),
                typeof(AssemblyInformationalVersionAttribute));
        if (attribute == null) throw new InvalidDataException();
        string[] fields = attribute.InformationalVersion.Split('|');
        if (fields.Length != 2 || string.IsNullOrWhiteSpace(fields[0]) || string.IsNullOrWhiteSpace(fields[1]))
            throw new InvalidDataException();
        return fields;
    }

    private static void SetCurrentServiceStatus(int state, int acceptedControls)
    {
        if (serviceStatusHandle == IntPtr.Zero) return;
        ServiceStatus status = new ServiceStatus
        {
            serviceType = ServiceWin32OwnProcess,
            currentState = state,
            controlsAccepted = acceptedControls,
        };
        SetServiceStatus(serviceStatusHandle, ref status);
    }

    private static void ServiceControlHandler(int control)
    {
        if (control != ServiceControlStop) return;
        SetCurrentServiceStatus(ServiceStopPending, 0);
        serviceStopEvent.Set();
        NamedPipeServerStream pipe = activeServicePipe;
        if (pipe != null)
        {
            try { pipe.Dispose(); } catch { }
        }
    }

    private sealed class ImportRequest
    {
        internal ImportRequest(byte[] encryptedKey, string chromeExecutablePath)
        {
            EncryptedKey = encryptedKey;
            ChromeExecutablePath = chromeExecutablePath;
        }
        internal byte[] EncryptedKey { get; private set; }
        internal string ChromeExecutablePath { get; private set; }
    }

    private sealed class ParsedAppBoundBlob
    {
        internal ParsedAppBoundBlob(byte[] validationData, byte[] content)
        {
            ValidationData = validationData;
            Content = content;
        }
        internal byte[] ValidationData { get; private set; }
        internal byte[] Content { get; private set; }
    }

    private sealed class ChromeValidationException : Exception { }
    private sealed class UnsupportedKeyException : Exception { }
    private sealed class CngException : Exception { }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob { internal int cbData; internal IntPtr pbData; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BcryptAuthenticatedCipherModeInfo
    {
        internal int cbSize; internal int dwInfoVersion;
        internal IntPtr pbNonce; internal int cbNonce;
        internal IntPtr pbAuthData; internal int cbAuthData;
        internal IntPtr pbTag; internal int cbTag;
        internal IntPtr pbMacContext; internal int cbMacContext;
        internal int cbAAD; internal long cbData; internal int dwFlags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ServiceTableEntry
    {
        [MarshalAs(UnmanagedType.LPWStr)] internal string serviceName;
        internal ServiceMainDelegate serviceMain;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        internal int serviceType; internal int currentState; internal int controlsAccepted;
        internal int win32ExitCode; internal int serviceSpecificExitCode;
        internal int checkPoint; internal int waitHint;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        internal int serviceType; internal int currentState; internal int controlsAccepted;
        internal int win32ExitCode; internal int serviceSpecificExitCode;
        internal int checkPoint; internal int waitHint;
        internal int processId; internal int serviceFlags;
    }

    private delegate void ServiceMainDelegate(int argc, IntPtr argv);
    private delegate void ServiceControlHandlerDelegate(int control);

    private const int ScManagerCreateService = 0x0002;
    private const int ScManagerConnect = 0x0001;
    private const int DeleteAccess = 0x00010000;
    private const int ServiceQueryStatus = 0x0004;
    private const int ServiceAllAccess = 0xF01FF;
    private const int ServiceWin32OwnProcess = 0x00000010;
    private const int ServiceDemandStart = 0x00000003;
    private const int ServiceErrorNormal = 0x00000001;
    private const int ServiceControlStop = 0x00000001;
    private const int ServiceStopped = 0x00000001;
    private const int ServiceStopPending = 0x00000003;
    private const int ServiceRunning = 0x00000004;
    private const int Win32OwnProcessAccepted = 0x00000001;
    private const int ServiceStatusProcessInfo = 0;
    private const int ProcessTerminate = 0x0001;
    private const int ProcessSynchronize = 0x00100000;
    private const int ProcessQueryLimitedInformation = 0x1000;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitFailed = 0xFFFFFFFF;
    private const int ErrorServiceDoesNotExist = 1060;
    private const int ErrorServiceNotActive = 1062;
    private const int ErrorServiceMarkedForDelete = 1072;
    private const int NCryptSilentFlag = 0x00000040;
    private const ushort ImageFileMachineUnknown = 0x0000;
    private const ushort ImageFileMachineI386 = 0x014c;
    private const ushort ImageFileMachineAmd64 = 0x8664;
    private const ushort ImageFileMachineArm64 = 0xAA64;

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, ref DataBlob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", EntryPoint = "RtlSecureZeroMemory")]
    private static extern IntPtr RtlSecureZeroMemory(IntPtr destination, UIntPtr length);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ImpersonateNamedPipeClient(IntPtr pipe);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool RevertToSelf();

    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptOpenStorageProvider(out IntPtr provider, string providerName, int flags);
    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptOpenKey(IntPtr provider, out IntPtr key, string keyName, int legacyKeySpec, int flags);
    [DllImport("ncrypt.dll")]
    private static extern int NCryptDecrypt(IntPtr key, byte[] input, int inputLength, IntPtr paddingInfo,
        byte[] output, int outputLength, out int resultLength, int flags);
    [DllImport("ncrypt.dll")] private static extern int NCryptFreeObject(IntPtr handle);

    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptOpenAlgorithmProvider(out IntPtr algorithm, string algorithmId, string implementation, int flags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptSetProperty(IntPtr handle, string property, byte[] input, int inputLength, int flags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptGetProperty(IntPtr handle, string property, byte[] output, int outputLength, out int result, int flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptGenerateSymmetricKey(IntPtr algorithm, out IntPtr key, byte[] keyObject,
        int keyObjectLength, byte[] secret, int secretLength, int flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptDecrypt(IntPtr key, byte[] input, int inputLength,
        ref BcryptAuthenticatedCipherModeInfo paddingInfo, byte[] iv, int ivLength,
        byte[] output, int outputLength, out int resultLength, int flags);
    [DllImport("bcrypt.dll")] private static extern int BCryptDestroyKey(IntPtr key);
    [DllImport("bcrypt.dll")] private static extern int BCryptCloseAlgorithmProvider(IntPtr algorithm, int flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, int exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, int milliseconds);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManager(string machineName, string databaseName, int desiredAccess);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenService(IntPtr manager, string serviceName, int desiredAccess);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateService(IntPtr manager, string serviceName, string displayName,
        int desiredAccess, int serviceType, int startType, int errorControl, string binaryPath,
        string loadOrderGroup, IntPtr tagId, string dependencies, string account, string password);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool StartService(IntPtr service, int argumentCount, string[] arguments);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DeleteService(IntPtr service);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ControlService(IntPtr service, int control, ref ServiceStatus status);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool QueryServiceStatusEx(IntPtr service, int infoLevel,
        ref ServiceStatusProcess status, int bufferSize, out int bytesNeeded);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool StartServiceCtrlDispatcher([In] ServiceTableEntry[] table);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterServiceCtrlHandler(string serviceName, ServiceControlHandlerDelegate handler);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetServiceStatus(IntPtr statusHandle, ref ServiceStatus status);
}
