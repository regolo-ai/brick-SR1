// Run from apps/router/src/spatial-router to emit the CLI's strict field schema.
package main
import (
 "encoding/json"
 "os"
 "reflect"
 "strings"
 "github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
)
func schema(t reflect.Type) any {
 for t.Kind() == reflect.Pointer { t = t.Elem() }
 switch t.Kind() {
 case reflect.Struct:
  fields := map[string]any{}
  for i:=0;i<t.NumField();i++ {
   field:=t.Field(i)
   if !field.IsExported() {continue}
   tag:=strings.Split(field.Tag.Get("yaml"),",")
   if tag[0]=="-" {continue}
   if len(tag)>1 && tag[1]=="inline" {
    nested:=schema(field.Type).(map[string]any)["fields"].(map[string]any)
    for name,value:=range nested {fields[name]=value}
   } else { name:=tag[0];if name=="" {name=strings.ToLower(field.Name)};fields[name]=schema(field.Type) }
  }
  return map[string]any{"fields":fields}
 case reflect.Map: return map[string]any{"values":schema(t.Elem())}
 case reflect.Array,reflect.Slice: return map[string]any{"items":schema(t.Elem())}
 case reflect.Interface: return map[string]any{"any":true}
 default: return map[string]any{"scalar":true}
 }
}
func main(){ encoder:=json.NewEncoder(os.Stdout);encoder.SetIndent("","  ");if err:=encoder.Encode(schema(reflect.TypeOf(config.RouterConfig{})));err!=nil{panic(err)} }
