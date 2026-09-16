export type AIConfig = {
    projects?:
        {
            name: string,
            path: string,
            comment?: string
        }[],    
    exclude_directories?: string[],
    max_match_count?: number,
    at_file_extensions?: string[],
    dollar_file_extensions?: string[]
}

export function defineConfig(config: AIConfig) : AIConfig
{
    return config;
}