export interface OutputStyle {
    id: string;
    name: string;
    description: string;
    content: string;
    isBuiltIn: boolean;
    enabled: boolean;
    filePath?: string; // 文件路径，用于编辑模式下打开文件
}

export interface OutputStyleConfig {
    name: string;
    description: string;
    content: string;
    enabled?: boolean;
}

export type OutputStyleGenerationStatus = 'idle' | 'generating' | 'completed' | 'error';
