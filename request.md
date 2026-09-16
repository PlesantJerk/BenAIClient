projects in your virutal folder:

The client stub that executes commands from you (the LLM) `F:\Code\node\BenAIClient`
The server blazor application: `f:\code\git\Phone\ChatAblaze\ChatAblaze`

Example CSharp code that ends up calling the client stub:

```csharp
            JsonObject message;
            string id = QAServerFeed.CreateJsonPayload("window_set_bounds", out message);
            message.Add("windowId", windowId);
            message.Add("x", x);
            message.Add("y", y);
            message.Add("width", width);
            message.Add("height", height);
            QAServerFeed.PushMessage(mSession.SubProfileEmail, message);
            JsonObject reply = WaitForReply(id);
            return reply.ToString();
```

The `window_set_bounds` in the above example ends up executing `F:\Code\node\BenAIClient\server.js`

You'll see in that file the hook that takes the `window_set_bounds` and maps it to a function that executes the task.

Simplified on the blazor side, the QAServerFeed `PushMessage` pushes the command into a queue on the server, the client does a long poll on the server.  When the command is pushed it triggers the wait handle the cleint is waiting on and the client executes the command and responds on the ID and then the server gets the values back.

For the ask I'm about to make we won't be building LLM tools, but i want to use this to communication to enhance my blazor UI.

There are two commands I want to make and they'd work similar.

I want to introduce two commands into the message input areas of the blazor app (`f:\code\git\Phone\ChatAblaze\ChatAblaze\Components\Pages\Home.razor`) the

in that file this is the current input area:

```razor
<textarea id="promptTextArea" @bind="mPrompt" class="chat-input" placeholder="Type your message here..."></textarea>
```

This should be activated if you type @projectname or $projectname

the projectname comes from the config file in my client application `F:\Code\node\BenAIClient\ai-config.mts`  -- the projects section

once you've typed the magic starting words i'd like some type of cancelable in place edit that the next letters you type do a search for files within the associated project directory to find all matching files (you should recurse down the directory tree to find the matches and ignore any directory that matches the configs `exclude_directories`).  You should match up to 10 matching names or, if specified in the config, the `max_match_count` number of matches.  This should include directory name that match (for the `@` symbol version).  Ideally the list should pick first names that match starting with what you typed, but if their is added room before making up the max matches, fill with names that contain matching text.

if the user clicks on one of the names then replace their typing with the relative path to the virtual directory for that file.  

You can start your search once they type at least 3 letters

Using up/down arrow shoudl allow selection.

User should be able to cancel out of this mode.

for mobile purposes, i'd like to have an icon for `@` and '$' embedded in the textarea -- i.e. make it look seeamless inside the prompt area (it doesn't actually need to be where you type text - it should not block you from typing or edting)

The `@` should scan all files and directories. the files should match extensions (cs, ts, js, razor, vue) by default, or if they specified `at_file_extensions` in the config that is the matching.

The '$' should not include directory names, but should pick up all files with extension type `md` or if they specified the `dollar_file_extensions` in the config file, the files that match those extensions.


You will be assume the presense of the `GlobalConfig` constant and that it contains the user's desired configuration.





