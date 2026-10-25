export type AIConfig = {
    /** Stable routing name; blank or default uses the legacy client queue. */
    client_name?: string,
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