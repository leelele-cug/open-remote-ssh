import * as crypto from 'crypto';
import Log from './common/logger';
import { getVSCodeServerConfig } from './serverConfig';
import SSHConnection from './ssh/sshConnection';

export interface ServerInstallOptions {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string; // vscodium specific
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
}

export interface ServerInstallResult {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: any;
}

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

export async function installCodeServer(
    conn: SSHConnection,
    serverDownloadUrlTemplate: string | undefined,
    extensionIds: string[],
    envVariables: string[],
    platform: string | undefined,
    useSocketPath: boolean,
    logger: Log
): Promise<ServerInstallResult> {
    let shell = 'powershell';

    logger.trace('[serverSetup] installCodeServer start: ' + JSON.stringify({
        platform,
        useSocketPath,
        extensionIds,
        envVariables
    }));

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        logger.trace('[serverSetup] detecting platform via uname -s');
        const result = await conn.exec('uname -s');

        logger.trace('[serverSetup] uname -s stdout:\n' + result.stdout);
        logger.trace('[serverSetup] uname -s stderr:\n' + result.stderr);

        if (result.stdout) {
            if (result.stdout.includes('windows32')) {
                platform = 'windows';
            } else if (result.stdout.includes('MINGW64')) {
                platform = 'windows';
                shell = 'bash';
            } else {
                logger.trace('[serverSetup] uname indicates non-windows platform');
            }
        } else if (result.stderr) {
            if (result.stderr.includes('FullyQualifiedErrorId : CommandNotFoundException')) {
                platform = 'windows';
            }

            if (result.stderr.includes('is not recognized as an internal or external command')) {
                platform = 'windows';
                shell = 'cmd';
            }
        }

        if (platform) {
            logger.trace(`[serverSetup] Detected platform: ${platform}, shell: ${shell}`);
        }
    }

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getVSCodeServerConfig();
    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: vscodeServerConfig.version,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: vscodeServerConfig.release,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE,
    };

    logger.trace('[serverSetup] install options prepared: ' + JSON.stringify({
        id: installOptions.id,
        version: installOptions.version,
        commit: installOptions.commit,
        quality: installOptions.quality,
        release: installOptions.release,
        serverApplicationName: installOptions.serverApplicationName,
        serverDataFolderName: installOptions.serverDataFolderName,
        serverDownloadUrlTemplate: installOptions.serverDownloadUrlTemplate
    }));

    let commandOutput: { stdout: string; stderr: string };

    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions);

        logger.trace('[serverSetup] Windows install script generated');
        logger.trace('Server install script:\n' + installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);

        let command = '';
        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                .replace(/^#.*$/gm, '')
                .replace(/\n{2,}/gm, '\n')
                .replace(/^\s*/gm, '')
                .replace(/"/g, '"""')
                .replace(/'/g, `''`)
                .replace(/>/g, `^>`)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('[serverSetup] Command length (8191 max): ' + command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        logger.trace('[serverSetup] executing windows install command:\n' + command);
        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions);

        logger.trace('[serverSetup] Unix install script generated');
        logger.trace('[serverSetup] Server install script content:\n' + installServerScript);

        const remoteScriptName = `${vscodeServerConfig.commit}-${scriptId}.sh`;
        const remoteScriptPath = `$HOME/${vscodeServerConfig.serverDataFolderName}/install/${remoteScriptName}`;
        const endRegex = new RegExp(`${scriptId}: end`);

        logger.trace('[serverSetup] remote script path:\n' + remoteScriptPath);

        const command = buildUnixInstallCommand(installServerScript, remoteScriptPath, scriptId);

        logger.trace('[serverSetup] executing unix install command:\n' + command);

        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    }

    if (commandOutput.stderr) {
        logger.trace('[serverSetup] Server install command stderr:\n' + commandOutput.stderr);
    }
    logger.trace('[serverSetup] Server install command stdout:\n' + commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        logger.trace('[serverSetup] Failed to parse install script output. Raw stdout:\n' + commandOutput.stdout);
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    logger.trace('[serverSetup] parsed install result map: ' + JSON.stringify(resultMap));

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(
        Object.entries(resultMap).filter(([key]) => envVariables.includes(key))
    );

    logger.trace('[serverSetup] installCodeServer success: ' + JSON.stringify({
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        remoteEnvVars
    }));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        if (!line.trim()) {
            continue;
        }

        const match = line.match(/^([^=]+)==(.*)==$/);
        if (match) {
            resultMap[match[1]] = match[2];
        }
    }

    return resultMap;
}

/**
 * Unix-like 系统安装命令：
 * - 尽量避免默认 shell（特别是 csh/tcsh）解析复杂语法
 * - 只做三件事：
 *   1. mkdir -p
 *   2. python3 落盘 bash 脚本
 *   3. bash 执行脚本
 */
function buildUnixInstallCommand(scriptContent: string, remoteScriptPath: string, scriptId: string): string {
    const scriptBase64 = Buffer.from(scriptContent, 'utf8').toString('base64');
    const remoteDir = remoteScriptPath.replace(/\/[^/]+$/, '');

    const pythonCode =
        `import base64, os, pathlib; ` +
        `p = pathlib.Path(os.path.expandvars('${escapeForPythonSingleQuoted(remoteScriptPath)}')); ` +
        `p.parent.mkdir(parents=True, exist_ok=True); ` +
        `p.write_bytes(base64.b64decode('${scriptBase64}')); ` +
        `print('[serverSetup:${scriptId}] python3 wrote script to ' + str(p))`;

    return [
        `echo "[serverSetup:${scriptId}] begin remote command"`,
        `echo "[serverSetup:${scriptId}] target script path: ${escapeForDoubleQuotedEcho(remoteScriptPath)}"`,
        `mkdir -p "${escapeForDoubleQuotedEcho(remoteDir)}"`,
        `echo "[serverSetup:${scriptId}] ensured install dir: ${escapeForDoubleQuotedEcho(remoteDir)}"`,
        `python3 -c "${escapeForDoubleQuotedPython(pythonCode)}"`,
        `echo "[serverSetup:${scriptId}] checking script file existence"`,
        `ls -l "${escapeForDoubleQuotedEcho(remoteScriptPath)}"`,
        `chmod 700 "${escapeForDoubleQuotedEcho(remoteScriptPath)}"`,
        `echo "[serverSetup:${scriptId}] chmod done, invoking bash"`,
        `bash "${escapeForDoubleQuotedEcho(remoteScriptPath)}"`
    ].join(' ; ');
}

function quoteForSingleQuotes(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForDoubleQuotes(value: string): string {
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function escapeForPythonSingleQuoted(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeForDoubleQuotedEcho(value: string): string {
    return value.replace(/(["\\$`])/g, '\\$1');
}

function escapeForDoubleQuotedPython(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
}

function generateBashInstallScript({
    id,
    quality,
    version,
    commit,
    release,
    extensionIds,
    envVariables,
    useSocketPath,
    serverApplicationName,
    serverDataFolderName,
    serverDownloadUrlTemplate
}: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');

    return `
#!/usr/bin/env bash
# Server installation script

set -e

debug() {
    echo "[serverSetup:${id}] DEBUG: $*"
}

info() {
    echo "[serverSetup:${id}] INFO: $*"
}

error() {
    echo "[serverSetup:${id}] ERROR: $*"
}

TMP_DIR="\${XDG_RUNTIME_DIR:-/tmp}"

DISTRO_VERSION="${version}"
DISTRO_COMMIT="${commit}"
DISTRO_QUALITY="${quality}"
DISTRO_VSCODIUM_RELEASE="${release ?? ''}"

SERVER_APP_NAME="${serverApplicationName}"
SERVER_INITIAL_EXTENSIONS="${extensions}"
SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"` : '--port=0'}"
SERVER_DATA_DIR="$HOME/${serverDataFolderName}"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=

print_install_results_and_exit() {
    info "printing install results, exitCode=$1"
    echo "${id}: start"
    echo "exitCode==$1=="
    echo "listeningOn==$LISTENING_ON=="
    echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
    echo "logFile==$SERVER_LOGFILE=="
    echo "osReleaseId==$OS_RELEASE_ID=="
    echo "arch==$ARCH=="
    echo "platform==$PLATFORM=="
    echo "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `echo "${envVar}==\${${envVar}:-}=="`).join('\n')}
    echo "${id}: end"
    exit 0
}

dump_server_log_tail() {
    if [[ -f "$SERVER_LOGFILE" ]]; then
        info "tail of server logfile: $SERVER_LOGFILE"
        tail -n 50 "$SERVER_LOGFILE" || true
    else
        info "server logfile does not exist: $SERVER_LOGFILE"
    fi
}

info "bash install script started"
debug "HOME=$HOME"
debug "SHELL=\${SHELL:-unknown}"
debug "TMP_DIR=$TMP_DIR"
debug "SERVER_DATA_DIR=$SERVER_DATA_DIR"
debug "SERVER_DIR=$SERVER_DIR"
debug "SERVER_SCRIPT=$SERVER_SCRIPT"
debug "SERVER_LOGFILE=$SERVER_LOGFILE"
debug "SERVER_PIDFILE=$SERVER_PIDFILE"
debug "SERVER_TOKENFILE=$SERVER_TOKENFILE"

KERNEL="$(uname -s)"
debug "uname -s => $KERNEL"
case "$KERNEL" in
    Darwin)
        PLATFORM="darwin"
        ;;
    Linux)
        PLATFORM="linux"
        ;;
    FreeBSD)
        PLATFORM="freebsd"
        ;;
    DragonFly)
        PLATFORM="dragonfly"
        ;;
    *)
        error "platform not supported: $KERNEL"
        print_install_results_and_exit 1
        ;;
esac
debug "PLATFORM=$PLATFORM"

ARCH="$(uname -m)"
debug "uname -m => $ARCH"
case "$ARCH" in
    x86_64 | amd64)
        SERVER_ARCH="x64"
        ;;
    armv7l | armv8l)
        SERVER_ARCH="armhf"
        ;;
    arm64 | aarch64)
        SERVER_ARCH="arm64"
        ;;
    ppc64le)
        SERVER_ARCH="ppc64le"
        ;;
    riscv64)
        SERVER_ARCH="riscv64"
        ;;
    loongarch64)
        SERVER_ARCH="loong64"
        ;;
    s390x)
        SERVER_ARCH="s390x"
        ;;
    *)
        error "architecture not supported: $ARCH"
        print_install_results_and_exit 1
        ;;
esac
debug "SERVER_ARCH=$SERVER_ARCH"

OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [[ -z "$OS_RELEASE_ID" ]]; then
    OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
    if [[ -z "$OS_RELEASE_ID" ]]; then
        OS_RELEASE_ID="unknown"
    fi
fi
debug "OS_RELEASE_ID=$OS_RELEASE_ID"

if [[ ! -d "$SERVER_DIR" ]]; then
    info "creating server install directory: $SERVER_DIR"
    mkdir -p "$SERVER_DIR"
    if (( $? > 0 )); then
        error "creating server install directory failed"
        print_install_results_and_exit 1
    fi
else
    info "server install directory already exists: $SERVER_DIR"
fi

if [[ "$OS_RELEASE_ID" == "alpine" ]]; then
    PLATFORM="$OS_RELEASE_ID"
    debug "platform adjusted for alpine => $PLATFORM"
fi

SERVER_DOWNLOAD_URL="$(echo "${serverDownloadUrlTemplate.replace(/\$\{/g, '\\${')}" | sed "s/\\\${quality}/$DISTRO_QUALITY/g" | sed "s/\\\${version}/$DISTRO_VERSION/g" | sed "s/\\\${commit}/$DISTRO_COMMIT/g" | sed "s/\\\${os}/$PLATFORM/g" | sed "s/\\\${arch}/$SERVER_ARCH/g" | sed "s/\\\${release}/$DISTRO_VSCODIUM_RELEASE/g")"
debug "SERVER_DOWNLOAD_URL=$SERVER_DOWNLOAD_URL"

if [[ ! -f "$SERVER_SCRIPT" ]]; then
    info "server script not found, will install"
    case "$PLATFORM" in
        darwin | linux | alpine )
            ;;
        *)
            error "'$PLATFORM' needs manual installation of remote extension host"
            print_install_results_and_exit 1
            ;;
    esac

    pushd "$SERVER_DIR" > /dev/null
    debug "entered directory: $SERVER_DIR"

    if [[ -n "$(command -v wget || true)" ]]; then
        info "using wget to download server"
        wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"
    elif [[ -n "$(command -v curl || true)" ]]; then
        info "using curl to download server"
        curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz "$SERVER_DOWNLOAD_URL"
    else
        error "no tool to download server binary"
        print_install_results_and_exit 1
    fi

    if (( $? > 0 )); then
        error "downloading server failed from $SERVER_DOWNLOAD_URL"
        print_install_results_and_exit 1
    fi

    info "download completed, extracting archive"
    tar -xf vscode-server.tar.gz --strip-components 1
    if (( $? > 0 )); then
        error "extracting server contents failed"
        print_install_results_and_exit 1
    fi

    if [[ ! -f "$SERVER_SCRIPT" ]]; then
        error "server contents are corrupted, script not found: $SERVER_SCRIPT"
        ls -la "$SERVER_DIR" || true
        print_install_results_and_exit 1
    fi

    rm -f vscode-server.tar.gz
    info "server installed successfully"

    popd > /dev/null
else
    info "server script already installed in $SERVER_SCRIPT"
fi

if [[ -f "$SERVER_PIDFILE" ]]; then
    SERVER_PID="$(cat "$SERVER_PIDFILE")"
    debug "existing pid file found, pid=$SERVER_PID"
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -p "$SERVER_PID" 2>/dev/null | grep "$SERVER_SCRIPT" || true)"
else
    debug "pid file not found, scanning process list"
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -A 2>/dev/null | grep "$SERVER_SCRIPT" | grep -v grep || true)"
fi

if [[ -z "$SERVER_RUNNING_PROCESS" ]]; then
    info "server is not running, starting a new one"

    if [[ -f "$SERVER_LOGFILE" ]]; then
        debug "removing old logfile: $SERVER_LOGFILE"
        rm -f "$SERVER_LOGFILE"
    fi
    if [[ -f "$SERVER_TOKENFILE" ]]; then
        debug "removing old tokenfile: $SERVER_TOKENFILE"
        rm -f "$SERVER_TOKENFILE"
    fi

    touch "$SERVER_TOKENFILE"
    chmod 600 "$SERVER_TOKENFILE"
    SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    echo "$SERVER_CONNECTION_TOKEN" > "$SERVER_TOKENFILE"
    debug "new token written to $SERVER_TOKENFILE"

    info "starting server process"
    debug "start command: $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms"
    "$SERVER_SCRIPT" --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file "$SERVER_TOKENFILE" --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms > "$SERVER_LOGFILE" 2>&1 &
    echo $! > "$SERVER_PIDFILE"
    debug "server started with pid=$(cat "$SERVER_PIDFILE" 2>/dev/null || true)"
else
    info "server script is already running: $SERVER_SCRIPT"
    debug "running process info: $SERVER_RUNNING_PROCESS"
fi

if [[ -f "$SERVER_TOKENFILE" ]]; then
    SERVER_CONNECTION_TOKEN="$(cat "$SERVER_TOKENFILE")"
    debug "SERVER_CONNECTION_TOKEN loaded from token file"
else
    error "server token file not found: $SERVER_TOKENFILE"
    dump_server_log_tail
    print_install_results_and_exit 1
fi

if [[ -f "$SERVER_LOGFILE" ]]; then
    info "waiting for server listening address from logfile"
    for i in {1..5}; do
        debug "checking logfile attempt $i"
        LISTENING_ON="$(grep -E 'Extension host agent listening on .+' "$SERVER_LOGFILE" 2>/dev/null | sed 's/Extension host agent listening on //')"
        if [[ -n "$LISTENING_ON" ]]; then
            debug "LISTENING_ON=$LISTENING_ON"
            break
        fi
        sleep 0.5
    done

    if [[ -z "$LISTENING_ON" ]]; then
        error "server did not start successfully"
        dump_server_log_tail
        print_install_results_and_exit 1
    fi
else
    error "server log file not found: $SERVER_LOGFILE"
    dump_server_log_tail
    print_install_results_and_exit 1
fi

info "server setup finished successfully"
print_install_results_and_exit 0
`;
}

function generatePowerShellInstallScript({
    id,
    quality,
    version,
    commit,
    release,
    extensionIds,
    envVariables,
    useSocketPath,
    serverApplicationName,
    serverDataFolderName,
    serverDownloadUrlTemplate
}: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');

    return `
# Server installation script

function DebugLog($msg) {
    Write-Output "[serverSetup:${id}] DEBUG: $msg"
}

function InfoLog($msg) {
    Write-Output "[serverSetup:${id}] INFO: $msg"
}

function ErrorLog($msg) {
    Write-Output "[serverSetup:${id}] ERROR: $msg"
}

$TMP_DIR="$env:TEMP\\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

$DISTRO_VERSION="${version}"
$DISTRO_COMMIT="${commit}"
$DISTRO_QUALITY="${quality}"
$DISTRO_VSCODIUM_RELEASE="${release ?? ''}"

$SERVER_APP_NAME="${serverApplicationName}"
$SERVER_INITIAL_EXTENSIONS="${extensions}"
$SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"` : '--port=0'}"
$SERVER_DATA_DIR="$(Resolve-Path ~)\\${serverDataFolderName}"
$SERVER_DIR="$SERVER_DATA_DIR\\bin\\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\\bin\\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.token"
$SERVER_ARCH=
$SERVER_CONNECTION_TOKEN=
$SERVER_DOWNLOAD_URL=

$LISTENING_ON=
$OS_RELEASE_ID=
$ARCH=
$PLATFORM="win32"

function printInstallResults($code) {
    InfoLog "printing install results, exitCode=$code"
    "${id}: start"
    "exitCode==$code=="
    "listeningOn==$LISTENING_ON=="
    "connectionToken==$SERVER_CONNECTION_TOKEN=="
    "logFile==$SERVER_LOGFILE=="
    "osReleaseId==$OS_RELEASE_ID=="
    "arch==$ARCH=="
    "platform==$PLATFORM=="
    "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `"${envVar}==$${envVar}=="`).join('\n')}
    "${id}: end"
}

InfoLog "powershell install script started"
DebugLog "TMP_DIR=$TMP_DIR"
DebugLog "SERVER_DIR=$SERVER_DIR"
DebugLog "SERVER_SCRIPT=$SERVER_SCRIPT"
DebugLog "SERVER_LOGFILE=$SERVER_LOGFILE"

$ARCH=$env:PROCESSOR_ARCHITECTURE
DebugLog "PROCESSOR_ARCHITECTURE=$ARCH"
if(($ARCH -eq "AMD64") -or ($ARCH -eq "IA64") -or ($ARCH -eq "ARM64")) {
    $SERVER_ARCH="x64"
}
else {
    ErrorLog "architecture not supported: $ARCH"
    printInstallResults 1
    exit 0
}

if(!(Test-Path $SERVER_DIR)) {
    InfoLog "creating server install directory: $SERVER_DIR"
    try {
        ni -it d $SERVER_DIR -f -ea si
    } catch {
        ErrorLog "creating server install directory failed - $($_.ToString())"
        exit 1
    }

    if(!(Test-Path $SERVER_DIR)) {
        ErrorLog "creating server install directory failed"
        exit 1
    }
}

cd $SERVER_DIR

if(!(Test-Path $SERVER_SCRIPT)) {
    InfoLog "server script not found, downloading package"
    del vscode-server.tar.gz

    $REQUEST_ARGUMENTS = @{
        Uri="${downloadUrl}"
        TimeoutSec=20
        OutFile="vscode-server.tar.gz"
        UseBasicParsing=$True
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    DebugLog "download url: ${downloadUrl}"

    Invoke-RestMethod @REQUEST_ARGUMENTS

    if(Test-Path "vscode-server.tar.gz") {
        InfoLog "download completed, extracting archive"
        tar -xf vscode-server.tar.gz --strip-components 1
        del vscode-server.tar.gz
    }

    if(!(Test-Path $SERVER_SCRIPT)) {
        ErrorLog "install server binary failed"
        exit 1
    }
}
else {
    InfoLog "server script already installed in $SERVER_SCRIPT"
}

if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\\*") {
    InfoLog "server script is already running $SERVER_SCRIPT"
}
else {
    InfoLog "server not running, starting"
    if(Test-Path $SERVER_LOGFILE) {
        del $SERVER_LOGFILE
    }
    if(Test-Path $SERVER_PIDFILE) {
        del $SERVER_PIDFILE
    }
    if(Test-Path $SERVER_TOKENFILE) {
        del $SERVER_TOKENFILE
    }

    $SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

    $SCRIPT_ARGUMENTS="--start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms *> '$SERVER_LOGFILE'"
    DebugLog "start args: $SCRIPT_ARGUMENTS"

    $START_ARGUMENTS = @{
        FilePath = "powershell.exe"
        WindowStyle = "hidden"
        ArgumentList = @(
            "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-c", "$SERVER_SCRIPT $SCRIPT_ARGUMENTS"
        )
        PassThru = $True
    }

    $SERVER_ID = (start @START_ARGUMENTS).ID

    if($SERVER_ID) {
        [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
        DebugLog "server started with pid=$SERVER_ID"
    }
}

if(Test-Path $SERVER_TOKENFILE) {
    $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
}
else {
    ErrorLog "server token file not found $SERVER_TOKENFILE"
    printInstallResults 1
    exit 0
}

sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
    Path = $SERVER_LOGFILE
    Pattern = "Extension host agent listening on (\\d+)"
}

for($I = 1; $I -le 5; $I++) {
    DebugLog "checking logfile attempt $I"
    if(Test-Path $SERVER_LOGFILE) {
        $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

        if($GROUPS) {
            $LISTENING_ON = $GROUPS[1].Value
            DebugLog "LISTENING_ON=$LISTENING_ON"
            break
        }
    }

    sleep -Milliseconds 500
}

if(!(Test-Path $SERVER_LOGFILE)) {
    ErrorLog "server log file not found $SERVER_LOGFILE"
    printInstallResults 1
    exit 0
}

InfoLog "server setup finished successfully"
printInstallResults 0

if($SERVER_ID) {
    while($True) {
        if(!(gps -Id $SERVER_ID)) {
            "server died, exit"
            exit 0
        }

        sleep 30
    }
}
`;
}
