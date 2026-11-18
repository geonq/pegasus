//! `files.describe`: whether each absolute path is a file, a readable folder, or gone, checked off
//! the async workers. The composer uses it before attaching a dropped folder as a path reference.
use pegasus_core::protocol::{
    ErrorCode, FileDescription, FileKind, FilesDescribeParams, FilesDescribeResult, HostError, DESCRIBE_MAX_PATHS,
};
use std::path::Path;

pub fn describe(params: FilesDescribeParams) -> Result<FilesDescribeResult, HostError> {
    if params.paths.len() > DESCRIBE_MAX_PATHS {
        return Err(HostError::new(ErrorCode::BadParams, format!("at most {DESCRIBE_MAX_PATHS} paths per call")));
    }
    let files = params.paths.into_iter().map(describe_one).collect::<Result<_, _>>()?;
    Ok(FilesDescribeResult { files })
}

fn describe_one(path: String) -> Result<FileDescription, HostError> {
    let p = Path::new(&path);
    // A relative path would resolve against the host's working directory, never the client's.
    if !p.is_absolute() {
        return Err(HostError::new(ErrorCode::BadPath, format!("not an absolute path: {path}")));
    }
    let name = p.file_name().map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned());
    let kind = match std::fs::metadata(p) {
        // A folder the agent cannot list is no use as a reference.
        Ok(meta) if meta.is_dir() => {
            if std::fs::read_dir(p).is_ok() { FileKind::Directory } else { FileKind::Missing }
        }
        Ok(_) => FileKind::File,
        Err(_) => FileKind::Missing,
    };
    Ok(FileDescription { path, name, kind })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(paths: Vec<String>) -> FilesDescribeParams {
        FilesDescribeParams { paths }
    }

    #[test]
    fn describes_folders_files_and_missing_paths() {
        let root = std::env::temp_dir().join(format!("pegasus-files-describe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();

        let r = describe(params(vec![s(&root), s(&root.join("a.txt")), s(&root.join("gone"))])).unwrap();
        let kinds: Vec<FileKind> = r.files.iter().map(|f| f.kind).collect();
        assert_eq!(kinds, [FileKind::Directory, FileKind::File, FileKind::Missing]);
        assert_eq!(r.files[0].name, root.file_name().unwrap().to_string_lossy());
        assert_eq!(r.files[1].name, "a.txt");
        assert_eq!(r.files[2].path, s(&root.join("gone")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_relative_paths_and_too_many_paths() {
        assert_eq!(describe(params(vec!["relative/dir".into()])).unwrap_err().code, ErrorCode::BadPath);
        let many = vec![std::env::temp_dir().to_string_lossy().into_owned(); DESCRIBE_MAX_PATHS + 1];
        assert_eq!(describe(params(many)).unwrap_err().code, ErrorCode::BadParams);
    }
}
