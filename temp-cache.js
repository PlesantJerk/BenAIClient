const { setTimeout: delay } = require('node:timers/promises');

class TempCache
{
    #items;
    #buffer = [];
    #stop = false;
    defaultBumpTime = 10;
    
    constructor()
    {
        this.#items = new Map();
        this.#poll();
    }

    destroy()
    {
        this.#stop = true;
    }

    set(key, target)
    {
        var entry = new TempCacheEntry(new TempCacheContainer(key, target, this.defaultBumpTime));
        if (!this.#items.get(key))
        {
            this.#items.set(key, entry);
            this.#buffer.push(entry);
        }
    }

    get(key)
    {
        var ret = null;
        var entry = this.#items.get(key);
        if (entry)
        {
            entry.container.bumpExpiration();
            ret = entry.container.target;
        }
        return ret;
    }

    async #poll()
    {
        while(!this.#stop)
        {
            await delay(30000);
            while(this.#buffer.length > 0)
            {
                var entry = this.#buffer[0];                
                if (entry.original_expiration <= new Date())
                {
                    var item = entry.container;
                    if (item.expiration <= new Date())
                    {
                        this.#items.delete(item.key);                        
                        if (item.target.remove)
                        {
                            await item.target.remove();
                        }
                    }
                    else
                    {
                        entry = new TempCacheEntry(item);
                        this.#items.set(item.key, entry);
                        this.#buffer.push(entry);
                    }
                    this.#buffer.shift();
                }
                else
                    break;
            }

        }
    }

}


class TempCacheContainer
{
    constructor(key, target, iTimeBump)
    {
        this.key = key;
        this.target = target;
        this.expiration = new Date();
        this.bump = iTimeBump;        
        this.bumpExpiration();
    }

    bumpExpiration()
    {
        this.expiration.setMinutes(this.expiration.getMinutes()+this.bump);
    }

}

class TempCacheEntry
{
    constructor(container)
    {
        this.container = container;
        this.original_expiration = new Date(this.container.expiration);
    }
}

module.exports = { TempCache }