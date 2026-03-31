import { z } from "zod";
declare const EnvSchema: z.ZodObject<{
    PORT: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    HOST: z.ZodDefault<z.ZodString>;
    LOG_LEVEL: z.ZodDefault<z.ZodString>;
    SYNESIS_PLANNER_URL: z.ZodDefault<z.ZodString>;
    SYNESIS_CRITIC_URL: z.ZodDefault<z.ZodString>;
    SYNESIS_CRITIC_MODEL: z.ZodDefault<z.ZodString>;
    SYNESIS_INTERNAL_SERVICE_TOKEN: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type McpConfig = z.infer<typeof EnvSchema>;
export declare function loadConfig(env?: NodeJS.ProcessEnv): McpConfig;
export {};
