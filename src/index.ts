import command from 'firebase-tools/lib/command.js';
import ensureApiEnabled from "firebase-tools/lib/ensureApiEnabled.js";
import functionsConfig from "firebase-tools/lib/functionsConfig.js";
import lifecycleHooks from 'firebase-tools/lib/deploy/lifecycleHooks.js';
import functionsEnv from "firebase-tools/lib/functions/env.js";
import { checkServiceAccountIam } from "firebase-tools/lib/deploy/functions/checkIam.js";
import { requirePermissions } from "firebase-tools/lib/requirePermissions.js";
import runtimes from 'firebase-tools/lib/deploy/functions/runtimes/index.js';
import prepareFunctionsUpload from 'firebase-tools/lib/deploy/functions/prepareFunctionsUpload.js';
import utils from 'firebase-tools/lib/projectUtils.js';
import childProcess from "child_process";

const origSpawn = childProcess.spawn

const newSpawn = function (command: string, args?: string[], options?: childProcess.SpawnOptionsWithStdioTuple<any, any, any> | childProcess.SpawnSyncOptionsWithStringEncoding) {
    /* 
        Monkey patching the spawn function because the predeploy hook spawn call
        just passes all handles. We need stdout for structured output however.
    */
    if (options?.stdio === 'inherit' || Array.isArray(options?.stdio) && options?.stdio?.every((val, i) => val === [0, 1, 2][i])) {
        options = { ...options, stdio: [0, 2, 2] }
    }
    return origSpawn.apply(null, [command, args!, options!])
}
childProcess.spawn = newSpawn as typeof origSpawn


async function prepare(context: any, options: any, payload: any) {
    const projectId = context.projectId
    const sourceDirName = options.config.get("functions.source");
    if (!sourceDirName) {
        throw new Error(`No functions code detected at default location (./functions), and no functions.source defined in firebase.json`);
    }
    const sourceDir = options.config.path(sourceDirName);
    const delegateContext = {
        projectId,
        sourceDir,
        projectDir: options.config.projectDir,
        runtime: options.config.get("functions.runtime") || "",
    };
    const runtimeDelegate = await runtimes.getRuntimeDelegate(delegateContext);
    options.delegateContext = delegateContext
    console.warn(`Validating ${runtimeDelegate.name} source`);
    await runtimeDelegate.validate();
    console.warn(`Building ${runtimeDelegate.name} source`);
    await runtimeDelegate.build();
    const checkAPIsEnabled = await Promise.all([
        ensureApiEnabled.ensure(projectId, "cloudfunctions.googleapis.com", "functions"),
        ensureApiEnabled.check(projectId, "runtimeconfig.googleapis.com", "runtimeconfig", true),
    ]);
    context.runtimeConfigEnabled = checkAPIsEnabled[1];
    const firebaseConfig = await functionsConfig.getFirebaseConfig(options);
    context.firebaseConfig = firebaseConfig;
    const runtimeConfig = await prepareFunctionsUpload.getFunctionsConfig(context);
    options.runtimeConfig = runtimeConfig;
    const firebaseEnvs = functionsEnv.loadFirebaseEnvs(firebaseConfig, projectId);
    const userEnvOpt = {
        functionsSource: sourceDir,
        projectId: projectId,
        projectAlias: options.projectAlias,
    };
    const userEnvs = functionsEnv.loadUserEnvs(userEnvOpt);
    console.warn(`Analyzing ${runtimeDelegate.name} backend spec`);
    const wantBackend = await runtimeDelegate.discoverSpec(runtimeConfig, firebaseEnvs);
    wantBackend.environmentVariables = { ...userEnvs, ...firebaseEnvs }
    payload.functions = { backend: wantBackend };

}

interface Query {
    firebase_config: string
    alias: string
    formatting?: "flat-json" | "json"
}

const readJsonFromStdin = () => new Promise((resolve: (a: Query) => void) => {
    const chunks: string[] = [];

    const readable = process.stdin
    readable.setEncoding('utf8')

    readable.on('readable', () => {
        let chunk;
        while (null !== (chunk = readable.read())) {
            chunks.push(chunk);
        }
    });

    readable.on('end', () => {
        resolve(JSON.parse(chunks.join('')));
    });

    readable.resume()
})

export async function main() {
    const query = await readJsonFromStdin()

    const cmd = new command.Command("")

    const options: any = {
        nonInteractive: true,
        config: query.firebase_config,
    }
    await cmd.prepare(options)

    const resolvedProject = options.rc.resolveAlias(query.alias);
    options.project = resolvedProject

    const projectId = utils.needProjectId(options)
    const payload: any = {}
    const context = { projectId }

    await lifecycleHooks("functions", "predeploy")(context, options)

    await requirePermissions(options, ["cloudconfig.configs.get"])
    await checkServiceAccountIam(options.project)
    await prepare(context, options, payload)


    const triggers = Object
        .values(payload.functions.backend.endpoints)
        .map((i: any) => Object.values(i))
        .flat(2)
        .map((i: any) => ({ ...i, environmentVariables: payload.functions.backend.environmentVariables }))


    const outputTriggers = Object.fromEntries(triggers.map(e => [`${e.id}-${e.region}`, e]))
    /*
        The content of each trigger is as described at:
        https://cloud.google.com/functions/docs/reference/rest/v1/projects.locations.functions#CloudFunction 
    */

    const ignore = [...(options.config.src.functions.ignore || ["node_modules", ".git"]), "firebase-debug.log", "firebase-debug.*.log", ".runtimeconfig.json"]

    switch (query?.formatting) {
        case "flat-json":
            process.stdout.write(JSON.stringify({
                projectId,
                ...options.delegateContext,
                runtime: undefined,
                ignore: JSON.stringify(ignore),
                runtimeConfig: JSON.stringify(options.runtimeConfig),
                triggers: JSON.stringify(outputTriggers)
            }, null, 2))
            break
        case "json":
        default:
            process.stdout.write(JSON.stringify({
                projectId,
                ...options.delegateContext,
                runtime: undefined,
                ignore,
                runtimeConfig: options.runtimeConfig,
                triggers: outputTriggers
            }, null, 2))
            break
    }
}
