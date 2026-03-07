const fsys = require('fs').promises;
const psys = require('path');

async function TestFindInFiles()
{
    var config = 
    {
        regular_expression: '\\bregular_expression\\b',
        view_window_size: 200,        
        exclude_directory_list: 'node_modules,.git'        
    }

    var ff = new FindInFile(config);
    return ff.Search('D:\\code\\node\\BenAIClient')
}

class FindInFile
{
    #regex
    #iViewWindowSize
    #extensions
    #excludeDirs

    constructor(config)
    {
        this.#regex = new RegExp(config.regular_expression, "gi");
        this.#iViewWindowSize = config.view_window_size;
        this.#extensions = [];
        if (config.file_extensions != null)
        {
            for(var ext of config.file_extensions.split(','))
                this.#extensions.push(ext.trim().toLowerCase());
        };
        this.#excludeDirs = [];
        if (config.exclude_directory_list != null)
        {
            for(var exclude of config.exclude_directory_list.split(','))
            {
                var temp = exclude.trim().toLowerCase();
                if (temp != "") this.#excludeDirs.push(temp);
            }
        }
    }

    async Search(sPath)
    {
        var ret = [];
        var files = await fsys.readdir(sPath, { withFileTypes: true, recursive: true });
        for(var file of files)
        {
            if (file.isFile() && this.#IsIncluded(file))
            {                
                var fullFileName = psys.join(file.path || file.parentPath, file.name);                
                var txt = await fsys.readFile(fullFileName, 'utf-8');    
                this.#regex.lastIndex = 0;            
                var matches = [...txt.matchAll(this.#regex)];
                for(var match of matches)
                {
                    var matchLength = match[0].length;
                    var startIndex = match.index-this.#iViewWindowSize;
                    if (startIndex < 0) startIndex =0;
                    var endIndex = match.index+matchLength + this.#iViewWindowSize;
                    if (endIndex > txt.length) endIndex = txt.length;
                    var returnFileName = "." + fullFileName.substring(sPath.length);
                    var entry = 
                    {
                        file_name: returnFileName,
                        start_index: match.index,
                        end_index: match.index + matchLength,
                        match_text: txt.substring(startIndex, endIndex)
                    };
                    ret.push(entry);
                }
            }
        }    
        return ret;     
    }

    #IsIncluded(oFile)
    {
        var ret = true;
        if (!this.#IsValidExtension(oFile))
            ret = false;
        else if (this.#IsExcludedPath(oFile))
            ret = false;
        return ret;
    }

    #IsExcludedPath(oFile)
    {        
        var sPath = oFile.path || oFile.parentPath;
        sPath = sPath.toLowerCase();
        var parts = sPath.split(psys.sep);
        var ret = false;
        for(var excl of this.#excludeDirs)
        {
            for(var part of parts)
            {
                if (part == excl)
                {
                    ret = true;
                    break;
                }
            }
            if (ret) break;
        }
        return ret;

    }
    #IsValidExtension(oFile)
    {
        var ret = false;
        if (this.#extensions.length == 0)
            ret = true;
        else 
        {
            var sName = oFile.name.toLowerCase();
            for(var ext of this.#extensions)
            {
                if (sName.endsWith(ext))
                {
                    ret = true;
                    break;
                }
            }
        }
        return ret;
    }
}

module.exports = { FindInFile, TestFindInFiles };
