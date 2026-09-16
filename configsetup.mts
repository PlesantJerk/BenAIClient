export type AIConfig = {
    projects?:
        {
            name: string,
            path: string,
            comment?: string
        }[],    
    exclude_directories?: string[]
}

export function defineConfig(config: AIConfig) : AIConfig
{
    return config;
}