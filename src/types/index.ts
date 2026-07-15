// Schema for repository file
export interface RepositoryFile {
  path: string;
  content: string;
  size: number;
  type: 'file' | 'directory' | 'symlink';
}

// Schema for repository tree node
export interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: TreeNode[];
}

// Schema for repository summary
export interface RepositorySummary {
  url: string;
  source: string;
  branch: string;
  commit: string;
  fileCount: number;
  directoryCount: number;
  totalSize: number;
  tokenCount: number;
  createdAt: string;
}

// Extended repository summary for local repositories
export interface LocalRepositorySummary extends Omit<RepositorySummary, 'url'> {
  path: string;
}
